import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DistillResult } from '../../core/types';

const FORMAT_VERSION = 1;
const KEY_LENGTH = 32;

export interface WebCacheEntry {
  v: number;
  url: string;
  etag?: string;
  lastModified?: string;
  storedAt: number;
  expiresAt?: number;
  result: DistillResult;
}

export interface WebCache {
  read(key: string): Promise<WebCacheEntry | null>;
  write(key: string, entry: Omit<WebCacheEntry, 'v'>): Promise<void>;
}

export function webCacheKey(parts: { url: string; version: string; boosters: readonly string[]; lingua: boolean; rate?: number; mode?: string }): string {
  const payload = JSON.stringify([FORMAT_VERSION, parts.url, parts.version, [...parts.boosters].sort(), parts.lingua, parts.lingua ? (parts.rate ?? null) : null, parts.mode ?? 'clean']);
  return createHash('sha256').update(payload).digest('hex').slice(0, KEY_LENGTH);
}

export interface CachePolicy {
  store: boolean;
  maxAgeMs?: number;
}

export function cachePolicy(cacheControl: string | undefined): CachePolicy {
  const directives = (cacheControl ?? '').toLowerCase().split(',').map((part) => part.trim());
  if (directives.includes('no-store')) return { store: false };
  const maxAge = directives.map((part) => /^max-age=(\d+)$/.exec(part)?.[1]).find((value) => value !== undefined);
  if (directives.includes('no-cache') || maxAge === undefined) return { store: true };
  return { store: true, maxAgeMs: Number(maxAge) * 1000 };
}

function isEntry(value: unknown): value is WebCacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const result = v.result as Record<string, unknown> | undefined;
  return (
    v.v === FORMAT_VERSION &&
    typeof v.url === 'string' &&
    typeof v.storedAt === 'number' &&
    typeof result === 'object' &&
    result !== null &&
    typeof result.markdown === 'string' &&
    typeof result.kind === 'string'
  );
}

export function createWebCache(dir: string): WebCache {
  const fileFor = (key: string): string => join(dir, `${key}.json`);
  return {
    async read(key) {
      try {
        const parsed: unknown = JSON.parse(await readFile(fileFor(key), 'utf8'));
        return isEntry(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async write(key, entry) {
      const path = fileFor(key);
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700).catch(() => {});
        await writeFile(tmp, JSON.stringify({ v: FORMAT_VERSION, ...entry }), { mode: 0o600 });
        await rename(tmp, path);
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
      }
    },
  };
}
