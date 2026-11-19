import { isAbsolute } from 'node:path';

export function cacheDirFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env.DISTILL_CACHE_DIR?.trim();
  if (raw === undefined || raw === '' || !isAbsolute(raw)) return undefined;
  return raw;
}
