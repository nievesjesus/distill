import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { opencodePluginSource } from '../../src/hooks/opencode-plugin';
import { opencodePluginPath, planOpencodeInstall } from '../../src/hooks/install-opencode';

interface Plugin {
  DistillPlugin: (ctx?: unknown) => Promise<{
    'tool.execute.before': (input: unknown, output: { args: Record<string, unknown> }) => Promise<void>;
  }>;
}

async function loadPlugin(script: string, ctx?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-oc-'));
  const bin = join(dir, 'fake-distill');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const file = join(dir, 'plugin.mjs');
  writeFileSync(file, opencodePluginSource(bin));
  const mod = (await import(pathToFileURL(file).href)) as Plugin;
  return (await mod.DistillPlugin(ctx))['tool.execute.before'];
}

const OK = '#!/bin/sh\necho \'{"path":"/cache/out/x.md"}\'\n';
const FAIL = '#!/bin/sh\nexit 1\n';

describe('opencodePluginSource', () => {
  it('imports as a module and exports the plugin', async () => {
    const before = await loadPlugin(OK);
    expect(typeof before).toBe('function');
  });

  it('rewrites filePath for a pdf', async () => {
    const before = await loadPlugin(OK);
    const output = { args: { filePath: '/docs/a.pdf' } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe('/cache/out/x.md');
  });

  it('leaves non-convertible extensions alone', async () => {
    const before = await loadPlugin(OK);
    for (const name of ['/src/a.ts', '/img/a.png', '/data/a.csv', '/a/noext']) {
      const output = { args: { filePath: name } };
      await before({ tool: 'read' }, output);
      expect(output.args.filePath).toBe(name);
    }
  });

  it('ignores other tools', async () => {
    const before = await loadPlugin(OK);
    const output = { args: { filePath: '/docs/a.pdf' } };
    await before({ tool: 'bash' }, output);
    expect(output.args.filePath).toBe('/docs/a.pdf');
  });

  it('keeps the original path when the command fails', async () => {
    const before = await loadPlugin(FAIL);
    const output = { args: { filePath: '/docs/a.pdf' } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe('/docs/a.pdf');
  });

  it('keeps the original path on garbage output', async () => {
    const before = await loadPlugin('#!/bin/sh\necho nope\n');
    const output = { args: { filePath: '/docs/a.pdf' } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe('/docs/a.pdf');
  });

  it('rewrites whichever argument name is present and writes it back to the same key', async () => {
    const before = await loadPlugin(OK);
    for (const key of ['file_path', 'path']) {
      const output = { args: { [key]: '/docs/a.docx' } };
      await before({ tool: 'read' }, output);
      expect(output.args[key]).toBe('/cache/out/x.md');
    }
  });

  it('resolves relative paths against the plugin directory', async () => {
    const echo = '#!/bin/sh\nprintf \'{"path":"%s.md"}\' "$3"\n';
    const before = await loadPlugin(echo, { directory: '/work/proj' });
    const output = { args: { filePath: 'docs/a.pdf' } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe('/work/proj/docs/a.pdf.md');
  });

  it('survives missing args', async () => {
    const before = await loadPlugin(OK);
    await expect(before({ tool: 'read' }, {} as { args: Record<string, unknown> })).resolves.toBeUndefined();
  });

  it('contains no comments', () => {
    expect(opencodePluginSource('distillmd')).not.toMatch(/\/\/|\/\*/);
  });
});

describe('opencode paths and plans', () => {
  it('resolves global and project locations', () => {
    expect(opencodePluginPath({ home: '/h', cwd: '/c', project: false })).toBe('/h/.config/opencode/plugins/distill.js');
    expect(opencodePluginPath({ home: '/h', cwd: '/c', project: true })).toBe('/c/.opencode/plugins/distill.js');
  });

  it('plans an install and detects an identical file', () => {
    const first = planOpencodeInstall(null, 'distillmd');
    expect(first.changed).toBe(true);
    expect(first.next).toBe(opencodePluginSource('distillmd'));
    expect(planOpencodeInstall(first.next, 'distillmd').changed).toBe(false);
    expect(planOpencodeInstall(first.next, 'npx -y distillmd@1').changed).toBe(true);
  });
});
