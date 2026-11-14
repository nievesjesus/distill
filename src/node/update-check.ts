import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../hooks/atomic';
import type { InstallMethod, UpdateCheck } from '../core/types';

export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/distill-llm/latest';

const DAY_MS = 24 * 3_600_000;
const BACKOFF_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 3000;
const FILE_NAME = 'update-check.json';
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

interface Stored { enabled?: boolean; checkedAt?: string; latest?: string }

function parseVersion(version: string): { core: number[]; pre: boolean } {
  const [core, ...rest] = version.trim().split('-');
  const parts = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { core: parts, pre: rest.length > 0 };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
}

export function detectInstallMethod(opts: { packageRoot: string; env: NodeJS.ProcessEnv }): InstallMethod {
  if (opts.env.DISTILL_DOCKER === '1') return 'docker';
  const path = opts.packageRoot.replace(/\\/g, '/');
  if (path.includes('/_npx/')) return 'npx';
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2 && segments[segments.length - 2] === 'node_modules') return 'npm-global';
  return 'source';
}

export interface UpdateChecker {
  status(): Promise<UpdateCheck>;
  check(opts?: { force?: boolean }): Promise<UpdateCheck>;
  setEnabled(enabled: boolean): Promise<UpdateCheck>;
}

export function createUpdateChecker(opts: {
  current: string;
  method: InstallMethod;
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): UpdateChecker {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const file = join(opts.cacheDir, FILE_NAME);
  let failedAt: number | null = null;

  const envValue = env.DISTILL_NO_UPDATE_CHECK;
  const envDisabled = envValue !== undefined && envValue !== '' && envValue !== '0';

  function read(): Stored {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
      const data = raw as Record<string, unknown>;
      const stored: Stored = {};
      if (typeof data.enabled === 'boolean') stored.enabled = data.enabled;
      if (typeof data.checkedAt === 'string' && !Number.isNaN(Date.parse(data.checkedAt))) stored.checkedAt = data.checkedAt;
      if (typeof data.latest === 'string' && PLAIN_VERSION.test(data.latest)) stored.latest = data.latest;
      return stored;
    } catch {
      return {};
    }
  }

  function write(stored: Stored): void {
    try {
      writeAtomic(file, JSON.stringify(stored));
      chmodSync(file, 0o600);
    } catch {}
  }

  function view(stored: Stored): UpdateCheck {
    const settingDisabled = stored.enabled === false;
    const latest = stored.latest ?? null;
    return {
      current: opts.current,
      latest,
      available: latest !== null && compareVersions(latest, opts.current) > 0,
      method: opts.method,
      enabled: !envDisabled && !settingDisabled,
      disabledBy: envDisabled ? 'env' : settingDisabled ? 'setting' : null,
      checkedAt: stored.checkedAt ?? null,
    };
  }

  async function fetchLatest(): Promise<string | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    const request = (async () => {
      const response = await doFetch(REGISTRY_LATEST_URL, {
        headers: { accept: 'application/json', 'user-agent': `distill-llm/${opts.current}` },
        signal,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === 'string' && PLAIN_VERSION.test(body.version) ? body.version : null;
    })();
    request.catch(() => {});
    return Promise.race([request, aborted]);
  }

  async function status(): Promise<UpdateCheck> {
    return view(read());
  }

  async function check(checkOpts: { force?: boolean } = {}): Promise<UpdateCheck> {
    const force = checkOpts.force === true;
    const stored = read();
    if (!force) {
      if (envDisabled || stored.enabled === false) return view(stored);
      const checkedAt = stored.checkedAt ? Date.parse(stored.checkedAt) : NaN;
      if (!Number.isNaN(checkedAt) && now() - checkedAt < DAY_MS) return view(stored);
      if (failedAt !== null && now() - failedAt < BACKOFF_MS) return view(stored);
    }
    let latest: string | null = null;
    try {
      latest = await fetchLatest();
    } catch {
      latest = null;
    }
    if (latest === null) {
      failedAt = now();
      return view(stored);
    }
    failedAt = null;
    const next: Stored = { ...stored, latest, checkedAt: new Date(now()).toISOString() };
    write(next);
    return view(next);
  }

  async function setEnabled(enabled: boolean): Promise<UpdateCheck> {
    const next: Stored = { ...read(), enabled };
    write(next);
    return view(next);
  }

  return { status, check, setEnabled };
}
