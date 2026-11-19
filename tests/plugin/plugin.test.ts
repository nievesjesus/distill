import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeSkillMarkdown } from '../../src/hooks/claude-skill';
import { isHookConvertible } from '../../src/hooks/supported';

const repo = resolve(__dirname, '..', '..');
const pluginDir = join(repo, 'plugins', 'distill');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(pluginDir, 'scripts', name)).href);

const jsonFiles = [
  join(repo, '.claude-plugin', 'marketplace.json'),
  join(pluginDir, '.claude-plugin', 'plugin.json'),
  join(pluginDir, 'hooks', 'hooks.json'),
  join(pluginDir, '.mcp.json'),
];

describe('plugin files', () => {
  it.each(jsonFiles)('%s parses', (path) => {
    expect(() => readJson(path)).not.toThrow();
  });

  it('plugin version matches the package version', () => {
    expect(readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version).toBe(readJson(join(repo, 'package.json')).version);
  });

  it('marketplace source points to the plugin directory', () => {
    const marketplace = readJson(join(repo, '.claude-plugin', 'marketplace.json'));
    const source: string = marketplace.plugins[0].source;
    expect(source.startsWith('./')).toBe(true);
    expect(existsSync(join(repo, source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('skill is identical to the one the installer writes', () => {
    const skill = readFileSync(join(pluginDir, 'skills', 'distill-office-documents', 'SKILL.md'), 'utf8');
    expect(skill).toBe(claudeSkillMarkdown('distill-llm'));
  });

  it('skill asks for a bounded read and explains the index', () => {
    const skill = claudeSkillMarkdown('distill-llm');
    expect(skill).toContain('distill-llm convert --stdout --max-tokens 8000 "<path>"');
    expect(skill).toContain('--offset');
    expect(skill).toContain('--limit');
  });

  it('bin/distill-llm is executable in git', () => {
    const out = spawnSync('git', ['ls-files', '-s', 'plugins/distill/bin/distill-llm'], { cwd: repo, encoding: 'utf8' }).stdout;
    expect(out.startsWith('100755')).toBe(true);
  });
});

describe('hook.mjs', () => {
  const extensions = ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'odt', 'ods', 'odp', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'txt', 'md'];

  it('convertible extensions match the TypeScript list', async () => {
    const { CONVERTIBLE_EXTENSIONS } = await load('hook.mjs');
    for (const ext of extensions) expect(CONVERTIBLE_EXTENSIONS.has(ext), ext).toBe(isHookConvertible(`a.${ext}`));
  });

  it('isCandidate filters reads', async () => {
    const { isCandidate } = await load('hook.mjs');
    const read = (input: Record<string, unknown>, tool = 'Read') => ({ tool_name: tool, tool_input: input });
    expect(isCandidate(read({ file_path: '/a/b.pdf' }))).toBe(true);
    expect(isCandidate(read({ file_path: '/a/b.PDF' }))).toBe(true);
    expect(isCandidate(read({ file_path: '/a/b.pdf' }, 'Bash'))).toBe(false);
    expect(isCandidate(read({ file_path: '/a/b.pdf', pages: '1-2' }))).toBe(false);
    expect(isCandidate(read({}))).toBe(false);
    expect(isCandidate(read({ file_path: 5 }))).toBe(false);
    expect(isCandidate(read({ file_path: '/a/b.png' }))).toBe(false);
    expect(isCandidate(null)).toBe(false);
    expect(isCandidate('x')).toBe(false);
  });
});

describe('launch.mjs', () => {
  it('packageSpec defaults to the plugin version and honours the override', async () => {
    const { packageSpec } = await load('launch.mjs');
    const version = readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version;
    expect(packageSpec({}, pluginDir)).toBe(`distill-llm@${version}`);
    expect(packageSpec({ DISTILL_PLUGIN_PACKAGE: '' }, pluginDir)).toBe(`distill-llm@${version}`);
    expect(packageSpec({ DISTILL_PLUGIN_PACKAGE: '/tmp/d.tgz' }, pluginDir)).toBe('/tmp/d.tgz');
  });

  it('npxCommand picks npx-cli next to node when present', async () => {
    const { npxCommand } = await load('launch.mjs');
    const yes = () => true;
    const no = () => false;
    expect(npxCommand('/opt/node/bin/node', 'darwin', yes)).toEqual({
      command: '/opt/node/bin/node',
      prefix: ['/opt/node/lib/node_modules/npm/bin/npx-cli.js'],
    });
    expect(npxCommand('/usr/bin/node', 'linux', yes).prefix[0]).toContain('npx-cli.js');
    const win = npxCommand('C:\\node\\node.exe', 'win32', yes);
    expect(win.command).toBe('C:\\node\\node.exe');
    expect(win.prefix[0]).toContain('npx-cli.js');
    expect(npxCommand('/usr/bin/node', 'linux', no)).toEqual({ command: 'npx', prefix: [] });
    expect(npxCommand('C:\\node\\node.exe', 'win32', no)).toEqual({ command: 'npx.cmd', prefix: [], unsupported: true });
  });

  it('npxArgs installs the spec and runs the distill-llm bin', async () => {
    const { npxArgs } = await load('launch.mjs');
    expect(npxArgs([], 'distill-llm@1.2.3', ['mcp', '--x'])).toEqual(['-y', '--package', 'distill-llm@1.2.3', 'distill-llm', 'mcp', '--x']);
    expect(npxArgs(['/n/npx-cli.js'], '/tmp/distill-llm-1.2.3.tgz', [])).toEqual([
      '/n/npx-cli.js',
      '-y',
      '--package',
      '/tmp/distill-llm-1.2.3.tgz',
      'distill-llm',
    ]);
  });

  it('nodeTooOld compares against 22.12.0', async () => {
    const { nodeTooOld } = await load('launch.mjs');
    expect(nodeTooOld('22.11.9')).toBe(true);
    expect(nodeTooOld('22.12.0')).toBe(false);
    expect(nodeTooOld('24.1.0')).toBe(false);
    expect(nodeTooOld('20.0.0')).toBe(true);
  });
});

describe('launch fallback', () => {
  const NOT_FOUND = 'npm error code ETARGET\nnpm error notarget No matching version found for distill-llm@9.9.9.\n';

  it('shouldFallback needs a failure, no override and a not-found error', async () => {
    const { shouldFallback } = await load('launch.mjs');
    expect(shouldFallback(1, NOT_FOUND, false)).toBe(true);
    expect(shouldFallback(1, 'npm error code E404', false)).toBe(true);
    expect(shouldFallback(0, NOT_FOUND, false)).toBe(false);
    expect(shouldFallback(1, NOT_FOUND, true)).toBe(false);
    expect(shouldFallback(1, 'something else broke', false)).toBe(false);
    expect(shouldFallback(1, '', false)).toBe(false);
  });

  function fakeSpawn(outcomes: { code: number; stderr?: string }[]) {
    const calls: { args: string[]; stdio: unknown }[] = [];
    const spawnFn = (_command: string, args: string[], options: { stdio: unknown }) => {
      const outcome = outcomes[calls.length] as { code: number; stderr?: string };
      calls.push({ args, stdio: options.stdio });
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setImmediate(() => {
        if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
        child.emit('close', outcome.code);
      });
      return child;
    };
    return { spawnFn, calls };
  }

  async function run(outcomes: { code: number; stderr?: string }[], options: Record<string, unknown> = {}) {
    const { launch } = await load('launch.mjs');
    const fake = fakeSpawn(outcomes);
    const written: string[] = [];
    const spawned: unknown[] = [];
    const code = await launch(['hook', 'claude'], {
      stdio: 'inherit',
      spawnFn: fake.spawnFn,
      env: {},
      writeStderr: (text: string) => written.push(text),
      onSpawn: (child: unknown) => spawned.push(child),
      ...options,
    });
    return { code, written, spawned, calls: fake.calls };
  }

  it('relaunches once with the latest release when the pinned version is not on npm', async () => {
    const result = await run([{ code: 1, stderr: NOT_FOUND }, { code: 0 }]);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]?.args).toContain('distill-llm@' + readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version);
    expect(result.calls[1]?.args).toContain('distill-llm@latest');
    expect(result.spawned).toHaveLength(2);
    expect(result.written.join('')).toContain('is not on npm yet; using the latest release');
  });

  it('does not relaunch when the package is overridden or the error is something else', async () => {
    const overridden = await run([{ code: 1, stderr: NOT_FOUND }], { env: { DISTILL_PLUGIN_PACKAGE: '/tmp/d.tgz' } });
    expect(overridden.code).toBe(1);
    expect(overridden.calls).toHaveLength(1);
    const other = await run([{ code: 3, stderr: 'boom' }]);
    expect(other.code).toBe(3);
    expect(other.calls).toHaveLength(1);
  });

  it('relaunches at most once', async () => {
    const result = await run([{ code: 1, stderr: NOT_FOUND }, { code: 1, stderr: NOT_FOUND }]);
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(2);
  });

  it('pipes stderr, forwarding it only when the caller inherits it', async () => {
    const inherit = await run([{ code: 0, stderr: 'progress' }]);
    expect(inherit.calls[0]?.stdio).toEqual(['inherit', 'inherit', 'pipe']);
    expect(inherit.written.join('')).toBe('progress');
    const ignored = await run([{ code: 0, stderr: 'progress' }], { stdio: ['pipe', 'inherit', 'ignore'] });
    expect(ignored.calls[0]?.stdio).toEqual(['pipe', 'inherit', 'pipe']);
    expect(ignored.written).toEqual([]);
  });
});

const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasClaude)('claude plugin validate', () => {
  it.each(['plugins/distill', '.'])('%s passes --strict', (target) => {
    const result = spawnSync('claude', ['plugin', 'validate', target, '--strict'], { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
