import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOOSTER_ORDER } from '../core/boosters/pipeline';
import type { Distiller } from '../node/distill';

export interface CacheDeps {
  distiller: Distiller;
  cacheDir: string;
  version: string;
}

export interface CachedConversion {
  mdPath: string;
  tokens: { raw: number; out: number } | null;
  cached: boolean;
}

const KEY_LENGTH = 32;

function cacheKey(version: string, bytes: Buffer): string {
  return createHash('sha256')
    .update(version)
    .update('\0')
    .update(BOOSTER_ORDER.join(','))
    .update('\0')
    .update(bytes)
    .digest('hex')
    .slice(0, KEY_LENGTH);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function convertCached(path: string, deps: CacheDeps): Promise<CachedConversion> {
  const bytes = await readFile(path);
  const outDir = join(deps.cacheDir, 'out');
  const mdPath = join(outDir, `${cacheKey(deps.version, bytes)}.md`);

  if (await exists(mdPath)) return { mdPath, tokens: null, cached: true };

  const result = await deps.distiller.distillFile(path);
  const header = `<!-- distill: ${result.name} · ${result.tokens.raw} → ${result.tokens.out} tokens -->`;
  await mkdir(outDir, { recursive: true });

  const tmpPath = `${mdPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmpPath, `${header}\n\n${result.markdown}`);
    await rename(tmpPath, mdPath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }

  return { mdPath, tokens: { raw: result.tokens.raw, out: result.tokens.out }, cached: false };
}
