import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { rename as realRename, rm as realRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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
    expect(calls[0].args).toEqual([...npm.prefixArgs, 'ci', '--omit=dev', '--include=peer', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(NPM_ARGS).toEqual(['ci', '--omit=dev', '--include=peer', '--ignore-scripts', '--no-audit', '--no-fund']);
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

  it('removes temporary directories older than the install timeout', async () => {
    const stale = join(cacheDir, 'lingua.installing-deadbeef');
    mkdirSync(stale, { recursive: true });
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(stale, longAgo, longAgo);
    const installer = make(succeed, { timeoutMs: 1000 });
    await installer.install();
    expect(readdirSync(cacheDir)).toEqual(['lingua']);
  });

  it('keeps a recent temporary directory that may belong to another running install', async () => {
    const other = join(cacheDir, 'lingua.installing-cafebabe');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'package.json'), '{}');
    const installer = make(succeed);
    await installer.install();
    expect(readdirSync(cacheDir).sort()).toEqual(['lingua', 'lingua.installing-cafebabe']);
    expect(existsSync(join(other, 'package.json'))).toBe(true);
  });

  it('dates leftovers by the time in their name, not by their contents', async () => {
    const longAgo = new Date(Date.now() - 60_000_000);
    const fresh = join(cacheDir, `lingua.old-${Date.now()}-abcd`);
    const expired = join(cacheDir, `lingua.old-${Date.now() - 600_000}-abcd`);
    for (const dir of [fresh, expired]) {
      mkdirSync(dir, { recursive: true });
      utimesSync(dir, longAgo, longAgo);
    }
    const installer = make(succeed, { timeoutMs: 1000 });
    await installer.install();
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(expired)).toBe(false);
  });

  it('names the temporary and aside directories with their creation time', async () => {
    mkdirSync(join(cacheDir, 'lingua', 'node_modules'), { recursive: true });
    const names: string[] = [];
    const installer = make(succeed, {
      fileOps: {
        rename: async (from: string, to: string) => {
          names.push(basename(from), basename(to));
          return realRename(from, to);
        },
      },
    });
    const before = Date.now();
    await installer.install();
    const stamped = names.filter((name) => name !== 'lingua');
    expect(stamped).toHaveLength(2);
    for (const name of stamped) {
      const time = Number(/^lingua\.(?:installing|old)-(\d{13})-[0-9a-f]+$/.exec(name)?.[1]);
      expect(time).toBeGreaterThanOrEqual(before);
      expect(time).toBeLessThanOrEqual(Date.now());
    }
  });

  it('sweeps expired leftovers without installing', async () => {
    const expired = join(cacheDir, `lingua.installing-${Date.now() - 600_000}-abcd`);
    const fresh = join(cacheDir, `lingua.installing-${Date.now()}-abcd`);
    mkdirSync(expired, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const installer = make(succeed, { timeoutMs: 1000 });
    await installer.sweep();
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('leaves the temporary directory in place when npm never closes after the kill', async () => {
    const installer = make(
      (child) => {
        child.kill = (signal?: string) => {
          child.killed = signal ?? 'SIGTERM';
          return true;
        };
      },
      { timeoutMs: 20, killGraceMs: 20 },
    );
    await expect(installer.install()).rejects.toMatchObject({ code: 'timeout' });
    expect(readdirSync(cacheDir).filter((name) => name.startsWith('lingua.installing-'))).toHaveLength(1);
  });

  it('never removes unrelated directories while cleaning', async () => {
    const unrelated = join(cacheDir, 'models');
    mkdirSync(unrelated, { recursive: true });
    const longAgo = new Date(Date.now() - 60_000_000);
    utimesSync(unrelated, longAgo, longAgo);
    const installer = make(succeed, { timeoutMs: 1000 });
    await installer.install();
    expect(existsSync(unrelated)).toBe(true);
  });

  it('waits for npm to close after killing it before reporting the timeout', async () => {
    const events: string[] = [];
    const installer = make(
      (child, call) => {
        child.kill = (signal?: string) => {
          child.killed = signal ?? 'SIGTERM';
          events.push('kill');
          setTimeout(() => {
            plantPackages(call.options.cwd);
            events.push('close');
            child.emit('close', null, 'SIGKILL');
          }, 40);
          return true;
        };
      },
      { timeoutMs: 20 },
    );
    await expect(installer.install().finally(() => events.push('settled'))).rejects.toMatchObject({ code: 'timeout' });
    expect(events).toEqual(['kill', 'close', 'settled']);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('surfaces the original failure when the cleanup itself fails', async () => {
    const installer = make(
      (child) => {
        child.stderr.write('npm error network request failed\n');
        child.emit('close', 1, null);
      },
      {
        fileOps: {
          rm: async (path: string, options: Record<string, unknown>) => {
            if (String(path).includes('installing-')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
            return realRm(path, options);
          },
        },
      },
    );
    await expect(installer.install()).rejects.toMatchObject({ code: 'npm_failed' });
    expect(installer.status().error?.message).toContain('network request failed');
  });

  it('moves the old install aside, swaps the new one in and removes the old one', async () => {
    const old = join(cacheDir, 'lingua');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'marker.txt'), 'old');
    const renames: string[] = [];
    const installer = make(succeed, {
      fileOps: {
        rename: async (from: string, to: string) => {
          renames.push(`${basename(from).replace(/-\d{13}-[0-9a-f]+$/, '-*')}>${basename(to).replace(/-\d{13}-[0-9a-f]+$/, '-*')}`);
          return realRename(from, to);
        },
      },
    });
    await installer.install();
    expect(renames).toEqual(['lingua>lingua.old-*', 'lingua.installing-*>lingua']);
    expect(readdirSync(cacheDir)).toEqual(['lingua']);
    expect(existsSync(join(old, 'marker.txt'))).toBe(false);
  });

  it('restores the previous install when the second rename fails', async () => {
    const old = join(cacheDir, 'lingua');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'marker.txt'), 'old');
    const installer = make(succeed, {
      fileOps: {
        rename: async (from: string, to: string) => {
          if (String(from).includes('installing-')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return realRename(from, to);
        },
      },
    });
    await expect(installer.install()).rejects.toMatchObject({ code: 'filesystem' });
    expect(readFileSync(join(old, 'marker.txt'), 'utf8')).toBe('old');
    expect(readdirSync(cacheDir)).toEqual(['lingua']);
  });

  it('retries a rename that fails with EPERM or EBUSY', async () => {
    let attempts = 0;
    const installer = make(succeed, {
      renameBackoffMs: 1,
      fileOps: {
        rename: async (from: string, to: string) => {
          if (String(from).includes('installing-')) {
            attempts += 1;
            if (attempts <= 2) throw Object.assign(new Error('locked'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
          }
          return realRename(from, to);
        },
      },
    });
    await installer.install();
    expect(attempts).toBe(3);
    expect(existsSync(join(cacheDir, 'lingua', 'node_modules'))).toBe(true);
  });

  it('gives up after five rename attempts', async () => {
    let attempts = 0;
    const installer = make(succeed, {
      renameBackoffMs: 1,
      fileOps: {
        rename: async (from: string, to: string) => {
          if (String(from).includes('installing-')) {
            attempts += 1;
            throw Object.assign(new Error('locked'), { code: 'EPERM' });
          }
          return realRename(from, to);
        },
      },
    });
    await expect(installer.install()).rejects.toMatchObject({ code: 'filesystem' });
    expect(attempts).toBe(5);
  });

  it('does not retry a rename that fails for another reason', async () => {
    let attempts = 0;
    const installer = make(succeed, {
      renameBackoffMs: 1,
      fileOps: {
        rename: async (from: string, to: string) => {
          if (String(from).includes('installing-')) {
            attempts += 1;
            throw Object.assign(new Error('nope'), { code: 'ENOSPC' });
          }
          return realRename(from, to);
        },
      },
    });
    await expect(installer.install()).rejects.toMatchObject({ code: 'filesystem' });
    expect(attempts).toBe(1);
  });

  it('still succeeds when the old install cannot be removed afterwards', async () => {
    const old = join(cacheDir, 'lingua');
    mkdirSync(old, { recursive: true });
    const installer = make(succeed, {
      fileOps: {
        rm: async (path: string, options: Record<string, unknown>) => {
          if (String(path).includes('.old-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          return realRm(path, options);
        },
      },
    });
    await installer.install();
    expect(existsSync(join(cacheDir, 'lingua', 'node_modules'))).toBe(true);
    expect(installer.status()).toEqual({ state: 'idle' });
  });

  it('never takes the install location from outside input', async () => {
    const installer = make(succeed);
    await (installer.install as (extra?: unknown) => Promise<void>)('../escape');
    expect(existsSync(join(root, 'escape'))).toBe(false);
    expect(existsSync(join(cacheDir, 'lingua'))).toBe(true);
  });

  describe('Intel Mac support', () => {
    const reason = 'LLMLingua-2 is not available on Intel Macs: its ONNX runtime only supports Apple Silicon.';

    it('reports a reason, is not installable and never resolves npm on darwin x64', async () => {
      const resolveNpm = vi.fn(async () => npm);
      const installer = createLinguaInstaller({ cacheDir, runtimeDir, resolveNpm, platform: 'darwin', arch: 'x64' });
      expect(installer.unsupportedReason?.()).toBe(reason);
      await expect(installer.probe()).resolves.toBe(false);
      expect(installer.installable()).toBe(false);
      expect(resolveNpm).not.toHaveBeenCalled();
    });

    it('rejects install with unsupported_platform and does not spawn npm', async () => {
      const installer = createLinguaInstaller({ cacheDir, runtimeDir, resolveNpm: async () => npm, platform: 'darwin', arch: 'x64' });
      await expect(installer.install()).rejects.toMatchObject({ code: 'unsupported_platform', message: reason });
      expect(calls).toHaveLength(0);
    });

    it.each([['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']] as const)('supports %s %s', async (platform, arch) => {
      const installer = createLinguaInstaller({ cacheDir, runtimeDir, resolveNpm: async () => npm, platform, arch });
      expect(installer.unsupportedReason?.()).toBeUndefined();
      await expect(installer.probe()).resolves.toBe(true);
    });
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
