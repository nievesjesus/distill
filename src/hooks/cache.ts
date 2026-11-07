import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOOSTER_ORDER, DEFAULT_ACTIVE } from '../core/boosters/pipeline';
import type { Distiller } from '../node/distill';
import { DistillError } from '../node/errors';
import { DEFAULT_MAX_BYTES } from '../node/limits';

export interface CacheDeps {
  getDistiller: () => Promise<Distiller>;
  cacheDir: string;
  version: string;
  liteparseVersion: string;
  maxBytes?: number;
}

export interface CachedConversion {
  mdPath: string;
  tokens: { raw: number; out: number } | null;
  cached: boolean;
}

const KEY_LENGTH = 32;
const ACTIVE_BOOSTERS = BOOSTER_ORDER.filter((id) => DEFAULT_ACTIVE.has(id)).join(',');

async function cacheKey(version: string, liteparseVersion: string, path: string): Promise<string> {
  const hash = createHash('sha256').update(version).update('\0').update(liteparseVersion).update('\0').update(ACTIVE_BOOSTERS).update('\0');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, KEY_LENGTH);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function convertCached(path: string, deps: CacheDeps): Promise<CachedConversion> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const info = await stat(path);
  if (info.size > maxBytes) throw new DistillError('too_large', `File exceeds the ${maxBytes} byte limit`);

  const outDir = join(deps.cacheDir, 'out');
  const mdPath = join(outDir, `${await cacheKey(deps.version, deps.liteparseVersion, path)}.md`);

  if (await isFile(mdPath)) return { mdPath, tokens: null, cached: true };

  const distiller = await deps.getDistiller();
  const result = await distiller.distillFile(path);
  if (result.markdown.trim() === '') throw new DistillError('parse_failed', 'Conversion produced no text');
  const header = `<!-- distill: ${result.name} · ${result.tokens.raw} → ${result.tokens.out} tokens -->`;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700).catch(() => {});

  const tmpPath = `${mdPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmpPath, `${header}\n\n${result.markdown}`, { mode: 0o600 });
    await rename(tmpPath, mdPath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    if (await isFile(mdPath)) return { mdPath, tokens: null, cached: true };
    throw error;
  }

  return { mdPath, tokens: { raw: result.tokens.raw, out: result.tokens.out }, cached: false };
}
