import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVOCATION_SOURCE, opencodePluginSource } from '../../src/hooks/opencode-plugin';
import { isOwnOpencodePlugin, opencodePluginPath, planOpencodeInstall } from '../../src/hooks/install-opencode';

interface Plugin {
  DistillPlugin: (ctx?: unknown) => Promise<{
    'tool.execute.before': (input: unknown, output: { args: Record<string, unknown> }) => Promise<void>;
  }>;
}

async function loadPlugin(script: string, ctx: unknown = { directory: fixtures }) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-oc-'));
  const bin = join(dir, 'fake-distill');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const file = join(dir, 'plugin.mjs');
  writeFileSync(file, opencodePluginSource(bin));
  const mod = (await import(pathToFileURL(file).href)) as Plugin;
  return (await mod.DistillPlugin(ctx))['tool.execute.before'];
}

const fixtures = mkdtempSync(join(tmpdir(), 'distill-oc-files-'));

function real(name: string): string {
  const file = join(fixtures, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'x');
  return file;
}

const posixOnly = process.platform === 'win32';
const OK = '#!/bin/sh\necho \'{"path":"/cache/out/x.md"}\'\n';
const FAIL = '#!/bin/sh\nexit 1\n';

describe('opencodePluginSource', () => {
  it('imports as a module and exports the plugin', async () => {
    const before = await loadPlugin(OK);
    expect(typeof before).toBe('function');
  });

  it.skipIf(posixOnly)('rewrites filePath for a pdf', async () => {
    const before = await loadPlugin(OK);
    const output = { args: { filePath: real('a.pdf') } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe('/cache/out/x.md');
  });

  it('leaves non-convertible extensions alone', async () => {
    const before = await loadPlugin(OK);
    for (const name of [real('a.ts'), real('a.png'), real('a.csv'), real('noext')]) {
      const output = { args: { filePath: name } };
      await before({ tool: 'read' }, output);
      expect(output.args.filePath).toBe(name);
    }
  });

  it('ignores other tools', async () => {
    const before = await loadPlugin(OK);
    const file = real('b.pdf');
    const output = { args: { filePath: file } };
    await before({ tool: 'bash' }, output);
    expect(output.args.filePath).toBe(file);
  });

  it('keeps the original path when the command fails', async () => {
    const before = await loadPlugin(FAIL);
    const file = real('c.pdf');
    const output = { args: { filePath: file } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe(file);
  });

  it('keeps the original path on garbage output', async () => {
    const before = await loadPlugin('#!/bin/sh\necho nope\n');
    const file = real('d.pdf');
    const output = { args: { filePath: file } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe(file);
  });

  it.skipIf(posixOnly)('rewrites whichever argument name is present and writes it back to the same key', async () => {
    const before = await loadPlugin(OK);
    for (const key of ['file_path', 'path']) {
      const output = { args: { [key]: real('e.docx') } };
      await before({ tool: 'read' }, output);
      expect(output.args[key]).toBe('/cache/out/x.md');
    }
  });

  it.skipIf(posixOnly)('resolves relative paths against the plugin directory', async () => {
    const echo = '#!/bin/sh\nprintf \'{"path":"%s.md"}\' "$3"\n';
    const before = await loadPlugin(echo, { directory: fixtures });
    real('docs/f.pdf');
    const output = { args: { filePath: 'docs/f.pdf' } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe(`${fixtures}/docs/f.pdf.md`);
  });

  it('never spawns for a nonexistent path', async () => {
    const marker = join(fixtures, 'spawned');
    const before = await loadPlugin(`#!/bin/sh\ntouch ${marker}\necho '{"path":"/cache/out/x.md"}'\n`);
    const output = { args: { filePath: join(fixtures, 'missing.pdf') } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe(join(fixtures, 'missing.pdf'));
    expect(existsSync(marker)).toBe(false);
  });

  it('never spawns for a path outside the project', async () => {
    const marker = join(fixtures, 'spawned-outside');
    const outsideDir = mkdtempSync(join(tmpdir(), 'distill-oc-outside-'));
    const outside = join(outsideDir, 'o.pdf');
    writeFileSync(outside, 'x');
    const before = await loadPlugin(`#!/bin/sh\ntouch ${marker}\necho '{"path":"/cache/out/x.md"}'\n`);
    const output = { args: { filePath: outside } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe(outside);
    expect(existsSync(marker)).toBe(false);
  });

  it('never spawns for a symlink inside the project that points outside', async () => {
    const marker = join(fixtures, 'spawned-link');
    const outsideDir = mkdtempSync(join(tmpdir(), 'distill-oc-outside-'));
    const target = join(outsideDir, 'o.pdf');
    writeFileSync(target, 'x');
    const link = join(fixtures, 'link.pdf');
    symlinkSync(target, link);
    const before = await loadPlugin(`#!/bin/sh\ntouch ${marker}\necho '{"path":"/cache/out/x.md"}'\n`);
    const output = { args: { filePath: link } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe(link);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(posixOnly)('converts a file inside the project', async () => {
    const before = await loadPlugin(OK);
    const output = { args: { filePath: real('inside/k.pdf') } };
    await before({ tool: 'read' }, output);
    expect(output.args.filePath).toBe('/cache/out/x.md');
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
    expect(opencodePluginPath({ home: '/h', cwd: '/c', project: false })).toBe(join('/h', '.config', 'opencode', 'plugins', 'distill.js'));
    expect(opencodePluginPath({ home: '/h', cwd: '/c', project: true })).toBe(join('/c', '.opencode', 'plugins', 'distill.js'));
  });

  it('plans an install and detects an identical file', () => {
    const first = planOpencodeInstall(null, 'distillmd');
    expect(first.changed).toBe(true);
    expect(first.next).toBe(opencodePluginSource('distillmd'));
    expect(planOpencodeInstall(first.next, 'distillmd').changed).toBe(false);
    expect(planOpencodeInstall(first.next, 'npx -y distillmd@1').changed).toBe(true);
  });
});

describe('invocation builder', () => {
  const build = new Function(`${INVOCATION_SOURCE}; return buildInvocation;`)() as (
    command: string[],
    file: string,
    platform: string,
  ) => { file: string; args: string[]; shell: boolean };

  it('runs directly on posix', () => {
    expect(build(['npx', '-y', 'distillmd@1'], '/a b/x.pdf', 'darwin')).toEqual({
      file: 'npx',
      args: ['-y', 'distillmd@1', 'hook', 'convert', '/a b/x.pdf'],
      shell: false,
    });
  });

  it('goes through a shell with quoted arguments on win32', () => {
    const result = build(['distillmd'], 'C:\\My Docs\\a & b.pdf', 'win32');
    expect(result).toEqual({ file: '"distillmd" "hook" "convert" "C:\\My Docs\\a & b.pdf"', args: [], shell: true });
  });

  it.each(['C:\\proj\\a" & calc & ".pdf', 'C:\\%USERPROFILE%.pdf', 'C:\\a!b.pdf', 'C:\\a\r\nb.pdf', 'C:\\a\u0000b.pdf'])(
    'refuses an unsafe win32 path %j',
    (file) => {
      expect(build(['distillmd'], file, 'win32')).toBeNull();
    },
  );

  it('recognizes its own plugin file', () => {
    expect(isOwnOpencodePlugin(opencodePluginSource('distillmd'))).toBe(true);
    expect(isOwnOpencodePlugin('export const Other = 1;')).toBe(false);
    expect(isOwnOpencodePlugin('export const DistillPlugin = 1; hook convert')).toBe(false);
  });
});
