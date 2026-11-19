import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACTIVE } from '../../core/boosters/pipeline';
import { countTokens } from '../../core/tokens';
import type { DistillResult, LocalBoosterId } from '../../core/types';
import { DistillError } from '../errors';
import { type WebCache, cachePolicy, webCacheKey } from './cache';
import { extractWeb, sourceHeader } from './extract';
import { type FetchOptions, type FetchResult, decodeText, normalizeUrl } from './fetch';
import { routeContent } from './route';

export interface UrlOptions {
  boosters?: ReadonlySet<LocalBoosterId>;
  lingua?: boolean;
  rate?: number;
  allowPrivate?: boolean;
  allowHosts?: readonly string[];
  robots?: 'ignore' | 'respect';
  mode?: 'clean' | 'full';
}

export interface UrlDistillerDeps {
  fetch: (url: string, options: FetchOptions) => Promise<FetchResult>;
  cache?: WebCache;
  version: string;
  now: () => number;
  checkLingua: (opts: UrlOptions) => void;
  polish: (markdown: string, opts: UrlOptions) => Promise<string>;
  distillDocument: (path: string, opts: UrlOptions) => Promise<DistillResult>;
}

function nameOf(finalUrl: string): string {
  const url = new URL(finalUrl);
  const segment = url.pathname.split('/').filter((part) => part !== '').pop();
  if (!segment) return url.hostname;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sentOverride(opts: UrlOptions): Partial<FetchOptions> {
  return {
    ...(opts.allowPrivate ? { allowPrivate: true } : {}),
    ...(opts.allowHosts && opts.allowHosts.length > 0 ? { allowHosts: opts.allowHosts } : {}),
    robotsPolicy: opts.robots ?? 'respect',
  };
}

export function createUrlDistiller(deps: UrlDistillerDeps): (rawUrl: string, opts?: UrlOptions) => Promise<DistillResult> {
  async function build(fetched: FetchResult, opts: UrlOptions): Promise<DistillResult> {
    const route = routeContent(fetched.contentType, fetched.finalUrl, fetched.body);
    if (route.type === 'unsupported') {
      throw new DistillError('unsupported_type', `The URL serves ${route.contentType || 'an unknown content type'}, which distill cannot read`);
    }
    if (route.type === 'document') {
      const dir = await mkdtemp(join(tmpdir(), 'distill-url-'));
      try {
        const path = join(dir, `page.${route.extension}`);
        await writeFile(path, fetched.body, { mode: 0o600 });
        const result = await deps.distillDocument(path, opts);
        return { ...result, path: fetched.finalUrl, name: nameOf(fetched.finalUrl) };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    const text = decodeText(fetched.body, fetched.contentType);
    const stamp = new Date(deps.now());
    let name: string;
    let markdown: string;
    if (route.type === 'html') {
      const extracted = await extractWeb(text, fetched.finalUrl, { now: () => stamp, ...(opts.mode ? { mode: opts.mode } : {}) });
      markdown = extracted.markdown;
      name = extracted.title || nameOf(fetched.finalUrl);
    } else {
      markdown = `${sourceHeader(fetched.finalUrl, stamp)}\n\n${text}`;
      name = nameOf(fetched.finalUrl);
    }
    const out = await deps.polish(markdown, opts);
    return {
      path: fetched.finalUrl,
      name,
      kind: 'HTML',
      pages: 1,
      markdown: out,
      tokens: { raw: countTokens(text), out: countTokens(out) },
      ms: 0,
      ...(route.type === 'markdown' ? { markdownServed: true } : {}),
    };
  }

  return async (rawUrl, opts = {}) => {
    const started = performance.now();
    const url = normalizeUrl(rawUrl);
    deps.checkLingua(opts);
    const trusted = opts.allowPrivate === true || (opts.allowHosts?.length ?? 0) > 0;
    const key =
      deps.cache && !trusted
        ? webCacheKey({
            url,
            version: deps.version,
            boosters: [...(opts.boosters ?? DEFAULT_ACTIVE)],
            lingua: opts.lingua ?? false,
            mode: opts.mode ?? 'clean',
            ...(opts.rate === undefined ? {} : { rate: opts.rate }),
          })
        : null;
    const cached = key === null || !deps.cache ? null : await deps.cache.read(key);
    const done = (result: DistillResult): DistillResult => ({ ...result, ms: Math.round(performance.now() - started) });
    if (cached?.expiresAt !== undefined && cached.expiresAt > deps.now()) return done(cached.result);

    const fetched = await deps.fetch(url, {
      ...sentOverride(opts),
      version: deps.version,
      ...(cached?.etag ? { etag: cached.etag } : {}),
      ...(cached?.lastModified ? { lastModified: cached.lastModified } : {}),
    });
    if (fetched.status === 304) {
      if (!cached) throw new DistillError('fetch_failed', 'The server answered 304 Not Modified to a request without validators');
      const policy = cachePolicy(fetched.cacheControl);
      if (key !== null && deps.cache && policy.store) {
        await deps.cache.write(key, {
          ...cached,
          storedAt: deps.now(),
          ...(policy.maxAgeMs === undefined ? {} : { expiresAt: deps.now() + policy.maxAgeMs }),
        });
      }
      return done(cached.result);
    }

    const result = done(await build(fetched, opts));
    const policy = cachePolicy(fetched.cacheControl);
    const revalidatable = fetched.etag !== undefined || fetched.lastModified !== undefined || policy.maxAgeMs !== undefined;
    if (key !== null && deps.cache && policy.store && revalidatable) {
      await deps.cache.write(key, {
        url,
        storedAt: deps.now(),
        ...(fetched.etag ? { etag: fetched.etag } : {}),
        ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
        ...(policy.maxAgeMs === undefined ? {} : { expiresAt: deps.now() + policy.maxAgeMs }),
        result,
      });
    }
    return result;
  };
}
