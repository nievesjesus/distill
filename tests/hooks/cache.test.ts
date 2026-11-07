import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Distiller } from '../../src/node/distill';
import { convertCached } from '../../src/hooks/cache';
import { DistillError } from '../../src/node/errors';

function fakeDistiller(impl?: () => Promise<never>) {
  const distillFile = vi.fn(
    impl ??
      (async (path: string) => ({
        name: path.split('/').pop() as string,
        markdown: '# Title\n\nbody',
        tokens: { raw: 120, out: 40 },
      })),
  );
  return { distillFile, health: vi.fn(), close: vi.fn() } as unknown as Distiller & {
    distillFile: ReturnType<typeof vi.fn>;
  };
}

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
    await rm(dir, { recursive: true, force: true });
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
    expect(entries).toEqual([`${a.mdPath.split('/').pop()}`]);
  });
});
