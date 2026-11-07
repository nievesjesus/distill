import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Distiller } from '../../src/node/distill';
import { convertCached as convertWith } from '../../src/hooks/cache';
import type { CacheDeps } from '../../src/hooks/cache';
import { DistillError } from '../../src/node/errors';

function fakeDistiller(impl?: () => Promise<never>) {
  const distillFile = vi.fn(
    impl ??
      (async (path: string) => ({
        name: basename(path),
        markdown: '# Title\n\nbody',
        tokens: { raw: 120, out: 40 },
      })),
  );
  return { distillFile, health: vi.fn(), close: vi.fn() } as unknown as Distiller & {
    distillFile: ReturnType<typeof vi.fn>;
  };
}

type TestDeps = Omit<CacheDeps, 'getDistiller' | 'liteparseVersion'> & { distiller: Distiller; liteparseVersion?: string };

const convertCached = (path: string, { distiller, liteparseVersion = '1.0.0', ...rest }: TestDeps) =>
  convertWith(path, { ...rest, liteparseVersion, getDistiller: async () => distiller });

describe('convertCached', () => {
  let dir: string;
  let cacheDir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'distill-cache-'));
    cacheDir = join(dir, 'cache');
    file = join(dir, 'report.pdf');
    await writeFile(file, 'content-a');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('converts once and serves the second call from cache', async () => {
    const distiller = fakeDistiller();
    const first = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });
    const second = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });

    expect(distiller.distillFile).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(first.tokens).toEqual({ raw: 120, out: 40 });
    expect(second.cached).toBe(true);
    expect(second.tokens).toBeNull();
    expect(second.mdPath).toBe(first.mdPath);
  });

  it('writes the header line, a blank line and the markdown under out/', async () => {
    const distiller = fakeDistiller();
    const { mdPath } = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });

    expect(mdPath.startsWith(join(cacheDir, 'out'))).toBe(true);
    expect(mdPath).toMatch(/[0-9a-f]{32}\.md$/);
    expect(await readFile(mdPath, 'utf8')).toBe('<!-- distill: report.pdf · 120 → 40 tokens -->\n\n# Title\n\nbody');
  });

  it('uses another key when one byte changes', async () => {
    const distiller = fakeDistiller();
    const a = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });
    await writeFile(file, 'content-b');
    const b = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });

    expect(b.mdPath).not.toBe(a.mdPath);
    expect(b.cached).toBe(false);
    expect(distiller.distillFile).toHaveBeenCalledTimes(2);
  });

  it('uses another key when the version changes', async () => {
    const distiller = fakeDistiller();
    const a = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });
    const b = await convertCached(file, { distiller, cacheDir, version: '1.0.1' });

    expect(b.mdPath).not.toBe(a.mdPath);
    expect(b.cached).toBe(false);
  });

  it('leaves no temp files when the distiller fails', async () => {
    const distiller = fakeDistiller(async () => {
      throw new Error('boom');
    });

    await expect(convertCached(file, { distiller, cacheDir, version: '1.0.0' })).rejects.toThrow('boom');
    const entries = await readdir(join(cacheDir, 'out')).catch(() => []);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('refuses files over maxBytes before calling the distiller', async () => {
    const distiller = fakeDistiller();
    const error = await convertCached(file, { distiller, cacheDir, version: '1.0.0', maxBytes: 4 }).catch((e) => e);

    expect(error).toBeInstanceOf(DistillError);
    expect(error.code).toBe('too_large');
    expect(distiller.distillFile).not.toHaveBeenCalled();
  });

  it('leaves no temp files when the final write fails', async () => {
    const distiller = fakeDistiller();
    const first = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });
    await rm(first.mdPath);
    await mkdir(join(first.mdPath, 'blocker'), { recursive: true });

    await expect(convertCached(file, { distiller, cacheDir, version: '1.0.0' })).rejects.toThrow();
    const entries = await readdir(join(cacheDir, 'out'));
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('resolves two concurrent calls to the same file without leftovers', async () => {
    const distiller = fakeDistiller();
    const [a, b] = await Promise.all([
      convertCached(file, { distiller, cacheDir, version: '1.0.0' }),
      convertCached(file, { distiller, cacheDir, version: '1.0.0' }),
    ]);

    expect(a.mdPath).toBe(b.mdPath);
    const entries = await readdir(join(cacheDir, 'out'));
    expect(entries).toEqual([basename(a.mdPath)]);
  });

  it('does not call getDistiller on a cache hit', async () => {
    const distiller = fakeDistiller();
    await convertCached(file, { distiller, cacheDir, version: '1.0.0' });
    const getDistiller = vi.fn(async () => distiller);
    const hit = await convertWith(file, { getDistiller, cacheDir, version: '1.0.0', liteparseVersion: '1.0.0' });

    expect(hit.cached).toBe(true);
    expect(getDistiller).not.toHaveBeenCalled();
  });

  it('calls getDistiller once on a miss', async () => {
    const distiller = fakeDistiller();
    const getDistiller = vi.fn(async () => distiller);
    await convertWith(file, { getDistiller, cacheDir, version: '1.0.0', liteparseVersion: '1.0.0' });

    expect(getDistiller).toHaveBeenCalledTimes(1);
  });

  it('uses another key when the liteparse version changes', async () => {
    const distiller = fakeDistiller();
    const a = await convertCached(file, { distiller, cacheDir, version: '1.0.0', liteparseVersion: '2.18.0' });
    const b = await convertCached(file, { distiller, cacheDir, version: '1.0.0', liteparseVersion: '2.19.0' });

    expect(b.mdPath).not.toBe(a.mdPath);
    expect(b.cached).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \n\t\n'],
    ['an empty LiteParse fence', '```text\n\n```'],
    ['empty fences with whitespace', '~~~\n \n~~~\n\n```\n```\n'],
  ])('rejects %s output without writing the cache', async (_label, markdown) => {
    const distiller = fakeDistiller(async () => ({ name: 'report.pdf', markdown, tokens: { raw: 5, out: 0 } }) as never);
    const error = await convertCached(file, { distiller, cacheDir, version: '1.0.0' }).catch((e) => e);

    expect(error).toBeInstanceOf(DistillError);
    expect(error.code).toBe('parse_failed');
    expect(error.message).toBe('Conversion produced no text');
    expect((await readdir(join(cacheDir, 'out'))).every((name) => name.endsWith('.empty'))).toBe(true);
  });

  it('remembers an empty conversion and fails again without opening the distiller', async () => {
    const distiller = fakeDistiller(async () => ({ name: 'report.pdf', markdown: '```text\n\n```', tokens: { raw: 5, out: 0 } }) as never);
    await convertCached(file, { distiller, cacheDir, version: '1.0.0' }).catch(() => {});
    const names = await readdir(join(cacheDir, 'out'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.empty$/);
    if (process.platform !== 'win32') expect((await stat(join(cacheDir, 'out', names[0]))).mode & 0o777).toBe(0o600);

    const getDistiller = vi.fn(async () => distiller);
    const error = await convertWith(file, { getDistiller, cacheDir, version: '1.0.0', liteparseVersion: '1.0.0' }).catch((e) => e);
    expect(error).toBeInstanceOf(DistillError);
    expect(error.code).toBe('parse_failed');
    expect(getDistiller).not.toHaveBeenCalled();
    expect(distiller.distillFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a fenced block with content', async () => {
    const distiller = fakeDistiller(async () => ({ name: 'report.pdf', markdown: '```text\nhello\n```', tokens: { raw: 5, out: 3 } }) as never);
    const result = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });
    expect(result.cached).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the out directory 0700 and the markdown 0600', async () => {
    const distiller = fakeDistiller();
    const { mdPath } = await convertCached(file, { distiller, cacheDir, version: '1.0.0' });

    expect((await stat(join(cacheDir, 'out'))).mode & 0o777).toBe(0o700);
    expect((await stat(mdPath)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens an existing out directory', async () => {
    await mkdir(join(cacheDir, 'out'), { recursive: true });
    await chmod(join(cacheDir, 'out'), 0o755);
    await convertCached(file, { distiller: fakeDistiller(), cacheDir, version: '1.0.0' });

    expect((await stat(join(cacheDir, 'out'))).mode & 0o777).toBe(0o700);
  });
});
