import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOOSTER_ORDER, DEFAULT_ACTIVE } from '../core/boosters/pipeline';
import { type SavingsEstimate, estimateSavings } from '../core/savings';
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
  savings: SavingsEstimate | null;
}

const KEY_LENGTH = 32;
const ACTIVE_BOOSTERS = BOOSTER_ORDER.filter((id) => DEFAULT_ACTIVE.has(id)).join(',');

const EMPTY_MESSAGE = 'Conversion produced no text';
const FENCE_LINE = /^\s*(```|~~~)[^\n]*$/gm;

function isEmptyMarkdown(markdown: string): boolean {
  return markdown.replace(FENCE_LINE, '').trim() === '';
}

async function cacheKey(version: string, liteparseVersion: string, path: string): Promise<string> {
  const hash = createHash('sha256').update(version).update('\0').update(liteparseVersion).update('\0').update(ACTIVE_BOOSTERS).update('\0');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, KEY_LENGTH);
}

function isSavingsEstimate(value: unknown): value is SavingsEstimate {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.baseline === 'number' &&
    typeof v.out === 'number' &&
    typeof v.saved === 'number' &&
    typeof v.percent === 'number' &&
    (v.basis === 'pdf-pages' || v.basis === 'raw-text')
  );
}

async function readSavings(path: string): Promise<SavingsEstimate | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isSavingsEstimate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSavings(path: string, savings: SavingsEstimate): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmpPath, JSON.stringify(savings), { mode: 0o600 });
    await rename(tmpPath, path);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
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
  const key = await cacheKey(deps.version, deps.liteparseVersion, path);
  const mdPath = join(outDir, `${key}.md`);
  const emptyPath = join(outDir, `${key}.empty`);
  const savingsPath = join(outDir, `${key}.savings.json`);

  if (await isFile(mdPath)) return { mdPath, tokens: null, cached: true, savings: await readSavings(savingsPath) };
  if (await isFile(emptyPath)) throw new DistillError('parse_failed', EMPTY_MESSAGE);

  const distiller = await deps.getDistiller();
  const result = await distiller.distillFile(path);
  if (isEmptyMarkdown(result.markdown)) {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await chmod(outDir, 0o700).catch(() => {});
    await writeFile(emptyPath, '', { mode: 0o600 }).catch(() => {});
    throw new DistillError('parse_failed', EMPTY_MESSAGE);
  }
  const header = `<!-- distill: ${result.name} · ${result.tokens.raw} → ${result.tokens.out} tokens -->`;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700).catch(() => {});

  const tmpPath = `${mdPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmpPath, `${header}\n\n${result.markdown}`, { mode: 0o600 });
    await rename(tmpPath, mdPath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    if (await isFile(mdPath)) return { mdPath, tokens: null, cached: true, savings: await readSavings(savingsPath) };
    throw error;
  }

  const savings = estimateSavings(result);
  await writeSavings(savingsPath, savings);
  return { mdPath, tokens: { raw: result.tokens.raw, out: result.tokens.out }, cached: false, savings };
}
