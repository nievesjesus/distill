import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_LATEST_URL, compareVersions, createUpdateChecker, detectInstallMethod } from '../../src/node/update-check';

const HOUR = 3_600_000;
let dir: string;
let calls: { url: string; init?: RequestInit }[];
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-update-'));
  calls = [];
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function okFetch(version = '0.2.0'): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ version }));
  }) as typeof fetch;
}

function make(over: Partial<Parameters<typeof createUpdateChecker>[0]> = {}) {
  return createUpdateChecker({ current: '0.1.2', method: 'npm-global', cacheDir: dir, env: {}, fetch: okFetch(), now: () => clock, ...over });
}

describe('compareVersions', () => {
  it('orders numerically and ranks prereleases below the release', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0);
  });
});

describe('detectInstallMethod', () => {
  it('classifies the package location', () => {
    expect(detectInstallMethod({ packageRoot: '/u/.npm/_npx/abc/node_modules/distill-llm', env: {} })).toBe('npx');
    expect(detectInstallMethod({ packageRoot: '/usr/local/lib/node_modules/distill-llm', env: {} })).toBe('npm-global');
    expect(detectInstallMethod({ packageRoot: 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\distill-llm', env: {} })).toBe('npm-global');
    expect(detectInstallMethod({ packageRoot: '/src/distill', env: {} })).toBe('source');
    expect(detectInstallMethod({ packageRoot: '/usr/local/lib/node_modules/distill-llm', env: { DISTILL_DOCKER: '1' } })).toBe('docker');
  });
});

describe('createUpdateChecker', () => {
  it('check finds a newer version', async () => {
    const result = await make().check();
    expect(result.available).toBe(true);
    expect(result.latest).toBe('0.2.0');
    expect(result.checkedAt).toBe(new Date(clock).toISOString());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(REGISTRY_LATEST_URL);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('user-agent')).toBe('distill-llm/0.1.2');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('check is cached for 24 hours', async () => {
    const checker = make();
    await checker.check();
    clock += 23 * HOUR;
    await checker.check();
    expect(calls).toHaveLength(1);
    clock += 2 * HOUR;
    await checker.check();
    expect(calls).toHaveLength(2);
  });

  it('env opt-out', async () => {
    const checker = make({ env: { DISTILL_NO_UPDATE_CHECK: '1' } });
    const result = await checker.check();
    expect(result.enabled).toBe(false);
    expect(result.disabledBy).toBe('env');
    expect(calls).toHaveLength(0);
    const forced = await checker.check({ force: true });
    expect(calls).toHaveLength(1);
    expect(forced.latest).toBe('0.2.0');
    const zero = await make({ env: { DISTILL_NO_UPDATE_CHECK: '0' } }).status();
    expect(zero.enabled).toBe(true);
    expect(zero.disabledBy).toBeNull();
  });

  it('setting opt-out persists', async () => {
    await make().setEnabled(false);
    const result = await make().check();
    expect(result.enabled).toBe(false);
    expect(result.disabledBy).toBe('setting');
    expect(calls).toHaveLength(0);
  });

  it('setEnabled keeps latest and checkedAt', async () => {
    await make().check();
    const result = await make().setEnabled(false);
    expect(result.latest).toBe('0.2.0');
    expect(result.checkedAt).not.toBeNull();
  });

  const bad: [string, typeof fetch][] = [
    ['html text', (async () => new Response('<html>nope</html>')) as typeof fetch],
    ['non-semver version', (async () => new Response('{"version":"latest"}')) as typeof fetch],
    ['prerelease version', (async () => new Response('{"version":"0.2.0-beta.1"}')) as typeof fetch],
    ['rejected fetch', (async () => { throw new Error('offline'); }) as typeof fetch],
    ['fetch that never resolves', (() => new Promise(() => {})) as typeof fetch],
  ];
  for (const [name, fetchImpl] of bad) {
    it(`bad registry answers are ignored: ${name}`, async () => {
      writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ latest: '0.1.5', checkedAt: new Date(clock - 48 * HOUR).toISOString() }));
      const result = await make({ fetch: fetchImpl, timeoutMs: 50 }).check();
      expect(result.latest).toBe('0.1.5');
    });
  }

  it('failure backs off for an hour', async () => {
    let n = 0;
    const failing = (async () => {
      n += 1;
      throw new Error('offline');
    }) as typeof fetch;
    const checker = make({ fetch: failing });
    await checker.check();
    expect(n).toBe(1);
    clock += 30 * 60_000;
    await checker.check();
    expect(n).toBe(1);
    clock += 31 * 60_000;
    await checker.check();
    expect(n).toBe(2);
  });

  it('corrupt file is tolerated', async () => {
    writeFileSync(join(dir, 'update-check.json'), '{nope');
    const result = await make().status();
    expect(result.enabled).toBe(true);
    expect(result.latest).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('unwritable cache dir is tolerated', async () => {
    const file = join(dir, 'plain');
    writeFileSync(file, 'x');
    const result = await make({ cacheDir: join(file, 'sub') }).check();
    expect(result.latest).toBe('0.2.0');
  });

  it('persists the result with owner-only permissions', async () => {
    await make().check();
    const saved = JSON.parse(readFileSync(join(dir, 'update-check.json'), 'utf8'));
    expect(saved.latest).toBe('0.2.0');
    expect(statSync(join(dir, 'update-check.json')).mode & 0o777).toBe(0o600);
  });
});
