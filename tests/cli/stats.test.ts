import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import type { Distiller } from '../../src/node/distill';
import { readStats } from '../../src/node/stats';

let dir: string;
let cacheDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-stats-cli-'));
  cacheDir = join(dir, 'cache');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeDistiller(): Distiller {
  return {
    renderPage: async () => { throw new Error('unused'); },
    async distillFile(path) {
      const name = basename(path);
      return { path, name, kind: 'PDF', pages: 3, markdown: `# ${name}\n`, tokens: { raw: 1000, out: 300 }, ms: 1 };
    },
    health: () => ({ version: '0.0.0', liteparseVersion: '0.0.0', libreoffice: false, lingua: { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 }, maxBytes: 1 }),
    close: () => {},
  };
}

function harness(env: Record<string, string | undefined> = { DISTILL_NO_UPDATE_CHECK: '1' }, extra: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const deps = {
    openDistiller: async () => fakeDistiller(),
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env,
    cacheDir,
    homeDir: join(dir, 'home'),
    cwd: dir,
    ...extra,
  };
  return { deps, stdout, stderr, exit };
}

describe('stats recording', () => {
  it('records a cli convert without paths', async () => {
    const file = join(dir, 'secret-name.pdf');
    writeFileSync(file, 'x');
    const h = harness();
    await run(['convert', file, '--out', join(dir, 'out')], h.deps);
    const raw = readFileSync(join(cacheDir, 'stats.jsonl'), 'utf8');
    expect(raw).not.toContain('secret-name');
    expect(readStats(cacheDir)).toMatchObject([{ source: 'cli', kind: 'PDF', baseline: 1000 + 1560 * 3, out: 300 }]);
  });

  it('records nothing with DISTILL_NO_STATS', async () => {
    const file = join(dir, 'a.pdf');
    writeFileSync(file, 'x');
    const h = harness({ DISTILL_NO_UPDATE_CHECK: '1', DISTILL_NO_STATS: '1' });
    await run(['convert', file, '--out', join(dir, 'out')], h.deps);
    expect(existsSync(join(cacheDir, 'stats.jsonl'))).toBe(false);
  });

  it('records a hook rewrite', async () => {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file }, cwd: dir });
    const h = harness({ DISTILL_NO_UPDATE_CHECK: '1' }, { readStdin: async () => payload });
    await run(['hook', 'claude'], h.deps).catch(() => {});
    expect(h.stdout.join('')).toContain('updatedInput');
    expect(readStats(cacheDir)).toMatchObject([{ source: 'hook', kind: 'PDF', out: 300 }]);
  });

  it('does not record a hook read with offset or limit', async () => {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 20 }, cwd: dir });
    const h = harness({ DISTILL_NO_UPDATE_CHECK: '1' }, { readStdin: async () => payload });
    await run(['hook', 'claude'], h.deps).catch(() => {});
    expect(h.stdout.join('')).toContain('updatedInput');
    expect(readStats(cacheDir)).toEqual([]);
  });
});

describe('DISTILL_CACHE_DIR', () => {
  it('moves the cache and the stats there', async () => {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const override = join(dir, 'override');
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file }, cwd: dir });
    const h = harness({ DISTILL_NO_UPDATE_CHECK: '1', DISTILL_CACHE_DIR: override }, { readStdin: async () => payload, cacheDir: undefined });
    await run(['hook', 'claude'], h.deps).catch(() => {});
    expect(h.stdout.join('')).toContain(join(override, 'out'));
    expect(readStats(override)).toMatchObject([{ source: 'hook', kind: 'PDF' }]);
  });
});

describe('stats command', () => {
  it('prints a summary', async () => {
    const file = join(dir, 'a.pdf');
    writeFileSync(file, 'x');
    await run(['convert', file, '--out', join(dir, 'out')], harness().deps);
    const h = harness();
    await run(['stats'], h.deps);
    const text = h.stdout.join('\n');
    expect(text).toContain('All time: 1 conversions');
    expect(text).toContain('cli: 1 conversions');
  });

  it('prints json and a dollar value with --price', async () => {
    const file = join(dir, 'a.pdf');
    writeFileSync(file, 'x');
    await run(['convert', file, '--out', join(dir, 'out')], harness().deps);
    const json = harness();
    await run(['stats', '--json'], json.deps);
    expect(JSON.parse(json.stdout[0] as string).all.count).toBe(1);
    const priced = harness();
    await run(['stats', '--price', '3'], priced.deps);
    expect(priced.stdout.join('\n')).toContain('$');
  });

  it('rejects an invalid price', async () => {
    const h = harness();
    h.exit.mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(run(['stats', '--price', 'abc'], h.deps)).rejects.toThrow('exit');
    expect(h.exit).toHaveBeenCalledWith(2);
  });

  it('says so when nothing was recorded', async () => {
    const h = harness();
    await run(['stats'], h.deps);
    expect(h.stdout).toEqual(['No conversions recorded yet.']);
  });
});
