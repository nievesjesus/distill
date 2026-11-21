import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEpub } from '../fixtures/epub';
import { makeMsg } from '../fixtures/make-msg';
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
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('distill-llm convert', () => {
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

function runCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

describe('distill-llm convert <url>', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const html = readFileSync(resolve('tests/fixtures/web/article.html'));
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/guide/widgets`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('refuses a cloud metadata address', () => {
    const result = runCli(['convert', '--stdout', 'http://169.254.169.254/latest/meta-data/']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden');
    expect(result.stdout).toBe('');
  });

  it('refuses a private address unless allowed', async () => {
    const result = await runCliAsync(['convert', '--stdout', base]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden');
  });

  it('converts a page with the bundled extractor when private access is allowed', async () => {
    const result = await runCliAsync(['convert', '--stdout', '--allow-private', base]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Using the Widget API');
    expect(result.stdout).toContain('## Creating a widget');
    expect(result.stdout).not.toContain('DISPLAY-NONE-MARKER');
    expect(result.stderr).toContain('vs the raw page');
  });

  it('reports tokens as json', async () => {
    const result = await runCliAsync(['convert', '--json', '--allow-private', '--out', work, base]);
    expect(result.status).toBe(0);
    const entry = JSON.parse(result.stdout)[0];
    expect(entry.tokens.raw).toBeGreaterThan(entry.tokens.out);
    expect(entry.output.endsWith('widgets.md')).toBe(true);
  });
});

describe('distill-llm convert saved formats', () => {
  it('converts an epub, an eml and a feed with the bundled readers', () => {
    const epub = join(work, 'book.epub');
    writeFileSync(epub, makeEpub({ chapters: [{ id: 'a', file: 'a.xhtml', title: 'First chapter', body: '<p>Once upon a time in the smoke test.</p>' }] }));
    const eml = join(work, 'note.eml');
    writeFileSync(eml, 'From: ada@example.com\r\nTo: bob@example.com\r\nSubject: Smoke mail\r\n\r\nHello from the smoke test.\r\n');
    const feed = join(work, 'feed.rss');
    writeFileSync(feed, '<rss version="2.0"><channel><title>Smoke feed</title><item><title>Entry one</title><link>https://example.com/1</link></item></channel></rss>');
    const book = runCli(['convert', '--stdout', epub]);
    expect(book.status).toBe(0);
    expect(book.stdout).toContain('## First chapter');
    const mail = runCli(['convert', '--stdout', eml]);
    expect(mail.status).toBe(0);
    expect(mail.stdout).toContain('# Smoke mail');
    const rss = runCli(['convert', '--stdout', feed]);
    expect(rss.status).toBe(0);
    expect(rss.stdout).toContain('- Link: https://example.com/1');
  });

  it('converts an Outlook message', () => {
    const msg = join(work, 'real.msg');
    writeFileSync(msg, makeMsg({ subject: 'Outlook smoke', senderName: 'Ada', senderEmail: 'ada@example.com', body: 'Body from msg.' }));
    const result = runCli(['convert', '--stdout', msg]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Outlook smoke');
    expect(result.stdout).toContain('Body from msg.');
  });

  it('reports a broken Outlook message instead of crashing', () => {
    const msg = join(work, 'broken.msg');
    writeFileSync(msg, 'not a compound file');
    const result = runCli(['convert', '--stdout', msg]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('parse_failed');
  });
});

describe('distill-llm hook claude', () => {
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

describe('distill-llm mcp', () => {
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
      expect(tools.map((tool) => tool.name).sort()).toEqual(['distill_capabilities', 'distill_file', 'distill_files', 'distill_outline', 'distill_page_image', 'distill_search', 'distill_url']);
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
        rmSync(outsideDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    } finally {
      await client?.close().catch(() => undefined);
      child.kill('SIGTERM');
    }
  });
});

describe('distill-llm grep --regex', () => {
  it('stops a catastrophic regex instead of hanging', () => {
    const file = join(work, 'evil.csv');
    writeFileSync(file, `word\n${'a'.repeat(40)}!\n`);
    const started = Date.now();
    const out = runCli(['grep', '--regex', '(a+)+$', file]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('took longer');
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe('distill-llm hooks install', () => {
  it('installs and uninstalls the claude hook in a temp home', () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    const install = runCli(['hooks', 'install', '--claude', '--yes']);
    expect(install.status).toBe(0);
    const installed = readFileSync(settingsPath, 'utf8');
    expect(installed).toContain('PreToolUse');
    expect(installed).toContain('hook claude');
    expect(installed).toContain('.cache/distill-llm/out');
    expect(JSON.parse(installed).permissions.allow.length).toBeGreaterThan(0);

    const uninstall = runCli(['hooks', 'uninstall', '--claude', '--yes']);
    expect(uninstall.status).toBe(0);
    const after = readFileSync(settingsPath, 'utf8');
    expect(after).not.toContain('hook claude');
    expect(after).not.toContain('distill-llm');
  });
});
