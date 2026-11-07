import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLinguaInstaller, findNpm, NPM_ARGS, REQUIRED_PACKAGES } from '../../src/node/lingua-install';

interface Call { command: string; args: string[]; options: Record<string, any> }

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string | undefined;
  kill(signal?: string) {
    this.killed = signal ?? 'SIGTERM';
    this.emit('close', null, this.killed);
    return true;
  }
}

function plantPackages(dir: string, names: readonly string[] = REQUIRED_PACKAGES) {
  for (const name of names) {
    const pkg = join(dir, 'node_modules', name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
}

describe('lingua installer', () => {
  let root: string;
  let runtimeDir: string;
  let cacheDir: string;
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const npm = { command: '/usr/bin/node', prefixArgs: ['/opt/npm/bin/npm-cli.js'] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'distill-install-'));
    runtimeDir = join(root, 'runtime');
    cacheDir = join(root, 'cache');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'package.json'), '{"name":"runtime"}');
    writeFileSync(join(runtimeDir, 'package-lock.json'), '{"lockfileVersion":3}');
    calls.length = 0;
    children.length = 0;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function make(onRun: (child: FakeChild, call: Call) => void, extra: Record<string, unknown> = {}) {
    return createLinguaInstaller({
      cacheDir,
      runtimeDir,
      resolveNpm: async () => npm,
      spawn: ((command: string, args: string[], options: Record<string, any>) => {
        const call = { command, args, options };
        calls.push(call);
        const child = new FakeChild();
        children.push(child);
        queueMicrotask(() => onRun(child, call));
        return child;
      }) as never,
      ...extra,
    });
  }

  const succeed = (child: FakeChild, call: Call) => {
    plantPackages(call.options.cwd);
    child.emit('close', 0, null);
  };

  it('runs npm ci with the exact arguments, no shell and the install directory as cwd', async () => {
    const installer = make(succeed);
    await installer.install();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(npm.command);
    expect(calls[0].args).toEqual([...npm.prefixArgs, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(NPM_ARGS).toEqual(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(calls[0].options.shell).toBeFalsy();
    expect(calls[0].options.cwd.startsWith(cacheDir)).toBe(true);
    expect(calls[0].options.cwd).not.toBe(join(cacheDir, 'lingua'));
  });

  it('copies package.json and package-lock.json from the runtime directory', async () => {
    let copied: string[] = [];
    const installer = make((child, call) => {
      copied = readdirSync(call.options.cwd).sort();
      expect(readFileSync(join(call.options.cwd, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}');
      succeed(child, call);
    });
    await installer.install();
    expect(copied).toEqual(['package-lock.json', 'package.json']);
  });

  it('renames the temporary directory into place and leaves no temporary directory behind', async () => {
    const installer = make(succeed);
    await installer.install();
    expect(existsSync(join(cacheDir, 'lingua', 'node_modules', '@atjsh', 'llmlingua-2', 'package.json'))).toBe(true);
    expect(readdirSync(cacheDir)).toEqual(['lingua']);
    expect(installer.status()).toEqual({ state: 'idle' });
  });

  it('replaces a previous installation only after the new one is complete', async () => {
    const old = join(cacheDir, 'lingua');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'marker.txt'), 'old');
    const installer = make((child, call) => {
      expect(existsSync(join(old, 'marker.txt'))).toBe(true);
      succeed(child, call);
    });
    await installer.install();
    expect(existsSync(join(old, 'marker.txt'))).toBe(false);
    expect(existsSync(join(old, 'node_modules'))).toBe(true);
  });

  it('cleans the temporary directory and keeps the old install when npm fails', async () => {
    const old = join(cacheDir, 'lingua');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'marker.txt'), 'old');
    const installer = make((child) => {
      child.stderr.write(`npm error network request failed\nnpm error log at ${cacheDir}/_logs/x.log\n`);
      child.emit('close', 1, null);
    });
    await expect(installer.install()).rejects.toMatchObject({ code: 'npm_failed' });
    expect(readdirSync(cacheDir)).toEqual(['lingua']);
    expect(existsSync(join(old, 'marker.txt'))).toBe(true);
    const status = installer.status();
    expect(status.state).toBe('failed');
    expect(status.error?.code).toBe('npm_failed');
    expect(status.error?.message).toContain('network request failed');
    expect(status.error?.message).not.toContain(cacheDir);
    expect(status.error?.message).not.toContain(root);
  });

  it('trims long npm output', async () => {
    const installer = make((child) => {
      child.stderr.write('x'.repeat(5000));
      child.emit('close', 1, null);
    });
    await expect(installer.install()).rejects.toBeDefined();
    expect(installer.status().error!.message.length).toBeLessThanOrEqual(300);
  });

  it('fails with verify_failed when the packages are missing after npm succeeds', async () => {
    const installer = make((child) => child.emit('close', 0, null));
    await expect(installer.install()).rejects.toMatchObject({ code: 'verify_failed' });
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('kills npm and reports a timeout', async () => {
    const installer = make(() => undefined, { timeoutMs: 20 });
    await expect(installer.install()).rejects.toMatchObject({ code: 'timeout' });
    expect(children[0].killed).toBeDefined();
    expect(readdirSync(cacheDir)).toEqual([]);
    expect(installer.status().error?.code).toBe('timeout');
  });

  it('reports npm_missing when no npm can be found', async () => {
    const installer = createLinguaInstaller({ cacheDir, runtimeDir, resolveNpm: async () => undefined });
    await expect(installer.install()).rejects.toMatchObject({ code: 'npm_missing' });
    expect(installer.status().state).toBe('failed');
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('reports a spawn error as npm_failed', async () => {
    const installer = make((child) => child.emit('error', new Error('spawn EACCES')));
    await expect(installer.install()).rejects.toMatchObject({ code: 'npm_failed' });
  });

  it('runs a single installation at a time and shares the result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const installer = make((child, call) => {
      void gate.then(() => succeed(child, call));
    });
    const first = installer.install();
    const second = installer.install();
    await Promise.resolve();
    expect(installer.status().state).toBe('installing');
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(installer.status().state).toBe('idle');
  });

  it('can retry after a failure', async () => {
    let attempt = 0;
    const installer = make((child, call) => {
      attempt += 1;
      if (attempt === 1) child.emit('close', 1, null);
      else succeed(child, call);
    });
    await expect(installer.install()).rejects.toBeDefined();
    expect(installer.status().state).toBe('failed');
    await installer.install();
    expect(installer.status()).toEqual({ state: 'idle' });
  });

  it('removes stale temporary directories from interrupted runs', async () => {
    mkdirSync(join(cacheDir, 'lingua.installing-deadbeef'), { recursive: true });
    const installer = make(succeed);
    await installer.install();
    expect(readdirSync(cacheDir)).toEqual(['lingua']);
  });

  it('never takes the install location from outside input', async () => {
    const installer = make(succeed);
    await (installer.install as (extra?: unknown) => Promise<void>)('../escape');
    expect(existsSync(join(root, 'escape'))).toBe(false);
    expect(existsSync(join(cacheDir, 'lingua'))).toBe(true);
  });

  it('is installable only when npm resolves', async () => {
    const yes = createLinguaInstaller({ cacheDir, runtimeDir, resolveNpm: async () => npm });
    const no = createLinguaInstaller({ cacheDir, runtimeDir, resolveNpm: async () => undefined });
    expect(yes.installable()).toBe(false);
    await expect(yes.probe()).resolves.toBe(true);
    await expect(no.probe()).resolves.toBe(false);
    expect(yes.installable()).toBe(true);
    expect(no.installable()).toBe(false);
  });
});

describe('findNpm', () => {
  const ok = async () => true;
  const no = async () => false;

  it('prefers the npm CLI script announced by npm_execpath', async () => {
    const found = await findNpm({
      env: { npm_execpath: '/x/lib/node_modules/npm/bin/npm-cli.js' },
      platform: 'linux',
      execPath: '/node/bin/node',
      isFile: async (path) => path === '/x/lib/node_modules/npm/bin/npm-cli.js',
      runs: ok,
    });
    expect(found).toEqual({ command: '/node/bin/node', prefixArgs: ['/x/lib/node_modules/npm/bin/npm-cli.js'] });
  });

  it('maps the npx CLI script to the sibling npm CLI script', async () => {
    const found = await findNpm({
      env: { npm_execpath: '/x/npm/bin/npx-cli.js' },
      platform: 'linux',
      execPath: '/node/bin/node',
      isFile: async (path) => path === '/x/npm/bin/npm-cli.js',
      runs: ok,
    });
    expect(found?.prefixArgs).toEqual(['/x/npm/bin/npm-cli.js']);
  });

  it('ignores a package manager that is not npm', async () => {
    const found = await findNpm({
      env: { npm_execpath: '/x/pnpm/bin/pnpm.cjs' },
      platform: 'linux',
      execPath: '/node/bin/node',
      isFile: no,
      runs: no,
    });
    expect(found).toBeUndefined();
  });

  it('finds the npm that ships next to node on Unix', async () => {
    const found = await findNpm({
      env: {},
      platform: 'linux',
      execPath: '/node/bin/node',
      isFile: async (path) => path === '/node/lib/node_modules/npm/bin/npm-cli.js',
      runs: ok,
    });
    expect(found?.prefixArgs).toEqual(['/node/lib/node_modules/npm/bin/npm-cli.js']);
  });

  it('finds the npm that ships next to node.exe on Windows', async () => {
    const found = await findNpm({
      env: {},
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      isFile: async (path) => path === 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js',
      runs: ok,
    });
    expect(found?.prefixArgs).toEqual(['C:\\node\\node_modules\\npm\\bin\\npm-cli.js']);
  });

  it('falls back to npm on PATH outside Windows and never on Windows', async () => {
    const unix = await findNpm({ env: {}, platform: 'linux', execPath: '/node/bin/node', isFile: no, runs: async (command) => command === 'npm' });
    expect(unix).toEqual({ command: 'npm', prefixArgs: [] });
    const windows = await findNpm({ env: {}, platform: 'win32', execPath: 'C:\\node\\node.exe', isFile: no, runs: async (command) => command === 'npm' });
    expect(windows).toBeUndefined();
  });

  it('is never available inside Electron', async () => {
    const found = await findNpm({
      env: { npm_execpath: '/x/npm/bin/npm-cli.js' },
      platform: 'darwin',
      execPath: '/app/Electron',
      electron: true,
      isFile: ok,
      runs: ok,
    });
    expect(found).toBeUndefined();
  });

  it('requires the candidate to actually run', async () => {
    const found = await findNpm({
      env: { npm_execpath: '/x/npm/bin/npm-cli.js' },
      platform: 'linux',
      execPath: '/node/bin/node',
      isFile: ok,
      runs: no,
    });
    expect(found).toBeUndefined();
  });
});
