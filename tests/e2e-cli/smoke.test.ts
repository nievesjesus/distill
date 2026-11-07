import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSamplePdf } from '../fixtures/make-pdf';

const CLI = resolve('dist/cli.js');

let home: string;
let work: string;
let pdf: string;
let env: Record<string, string>;
let reportedTokens: { raw: number; out: number };

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8', timeout: 50000 });
}

function readPreToolUse(path: string) {
  return JSON.stringify({
    session_id: 's',
    cwd: work,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path },
    tool_use_id: 't',
  });
}

beforeAll(() => {
  expect(existsSync(CLI)).toBe(true);
  home = mkdtempSync(join(tmpdir(), 'distill-smoke-home-'));
  work = mkdtempSync(join(tmpdir(), 'distill-smoke-work-'));
  pdf = join(work, 'sample.pdf');
  writeFileSync(pdf, makeSamplePdf(['Distill smoke test', 'The quick brown fox jumps over the lazy dog', 'Second line of the document']));
  env = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home };
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('distillmd convert', () => {
  it('converts a pdf and reports tokens as json', () => {
    const result = runCli(['convert', pdf, '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const entry = parsed[0];
    expect(entry.tokens.out).toBeGreaterThan(0);
    expect(entry.tokens.raw).toBeGreaterThanOrEqual(entry.tokens.out);
    expect(existsSync(entry.output)).toBe(true);
    expect(entry.output.endsWith('.md')).toBe(true);
    reportedTokens = entry.tokens;
  });
});

describe('distillmd hook claude', () => {
  it('rewrites a pdf read to a cached markdown file and hits the cache on rerun', () => {
    for (let i = 0; i < 2; i++) {
      const result = runCli(['hook', 'claude'], readPreToolUse(pdf));
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      const updated = output.hookSpecificOutput.updatedInput.file_path as string;
      expect(updated.endsWith('.md')).toBe(true);
      expect(existsSync(updated)).toBe(true);
      expect(updated.startsWith(home)).toBe(true);
    }
  });

  it('passes unsupported files through silently', () => {
    const png = join(work, 'image.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = runCli(['hook', 'claude'], readPreToolUse(png));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('distillmd mcp', () => {
  it('serves tools over stdio with a clean stdout', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'pipe' });
    let stderr = '';
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    try {
      await client.connect(transport);
      transport.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['distill_capabilities', 'distill_file', 'distill_files']);
      const result = await client.callTool({ name: 'distill_file', arguments: { path: pdf } });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { tokens: { raw: number; out: number } };
      expect(structured.tokens).toEqual(reportedTokens);
    } finally {
      await client.close();
    }
    expect(stderr).not.toMatch(/\bat .*\(.*:\d+:\d+\)|Error:/);
  });

  it('serves over http confined to --root', async () => {
    const child: ChildProcess = spawn(process.execPath, [CLI, 'mcp', '--http', '--port', '0', '--root', work], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let client: Client | undefined;
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`no url: ${buffer}`)), 30000);
        child.stderr?.on('data', (chunk) => {
          buffer += String(chunk);
          const match = buffer.match(/distill MCP at (\S+)/);
          if (match) {
            clearTimeout(timer);
            resolveUrl(match[1]);
          }
        });
        child.once('exit', (code) => reject(new Error(`exited ${code}: ${buffer}`)));
      });
      client = new Client({ name: 'smoke', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const inside = await client.callTool({ name: 'distill_file', arguments: { path: pdf } });
      expect(inside.isError).toBeFalsy();
      expect((inside.structuredContent as { tokens: unknown }).tokens).toEqual(reportedTokens);

      const outsideDir = mkdtempSync(join(tmpdir(), 'distill-smoke-outside-'));
      try {
        const outsidePdf = join(outsideDir, 'outside.pdf');
        writeFileSync(outsidePdf, makeSamplePdf(['outside']));
        const outside = await client.callTool({ name: 'distill_file', arguments: { path: outsidePdf } });
        expect(outside.isError).toBe(true);
        expect(JSON.stringify(outside.content)).toContain('forbidden');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      await client?.close().catch(() => undefined);
      child.kill('SIGTERM');
    }
  });
});

describe('distillmd hooks install', () => {
  it('installs and uninstalls the claude hook in a temp home', () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    const install = runCli(['hooks', 'install', '--claude', '--yes']);
    expect(install.status).toBe(0);
    const installed = readFileSync(settingsPath, 'utf8');
    expect(installed).toContain('PreToolUse');
    expect(installed).toContain('hook claude');
    expect(installed).toContain('.cache/distillmd/out');
    expect(JSON.parse(installed).permissions.allow.length).toBeGreaterThan(0);

    const uninstall = runCli(['hooks', 'uninstall', '--claude', '--yes']);
    expect(uninstall.status).toBe(0);
    const after = readFileSync(settingsPath, 'utf8');
    expect(after).not.toContain('hook claude');
    expect(after).not.toContain('distillmd');
  });
});
