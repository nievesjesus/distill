import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { detectKind, needsLibreOffice } from '../core/kind';
import { isLoopbackHost } from '../core/loopback';
import type { ApiError, ErrorCode, Health, LinguaModel, ParseResponse } from '../core/types';
import { DistillError } from '../node/errors';
import type { Lingua } from '../node/lingua';
import type { Parser } from '../node/parse';
import { hostnameOf, isAllowedHost, isCrossSiteRequest, originHostname } from './guards';
import type { Store } from './store';

export interface AppDeps {
  parser: Parser;
  lingua: Lingua;
  store: Store;
  maxBytes: number;
  libreoffice: boolean;
  version: string;
  liteparseVersion: string;
  webRoot?: string;
  guardLoopback: boolean;
  allowedHosts: readonly string[];
}

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_COMPRESS_CHARS = 5_000_000;
const MAX_COMPRESS_BODY_BYTES = MAX_COMPRESS_CHARS * 4 + MULTIPART_OVERHEAD_BYTES;
const UNKNOWN_HOST_MESSAGE = 'Request blocked: unknown host. Allow it with --allowed-hosts or DISTILL_ALLOWED_HOSTS';
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const LINGUA_MODELS: ReadonlySet<string> = new Set<LinguaModel>(['tinybert', 'mobilebert', 'xlm-roberta']);

const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unsupported_type: 400,
  not_found: 404,
  too_large: 413,
  needs_libreoffice: 422,
  password_protected: 422,
  parse_failed: 422,
  timeout: 504,
  lingua_unavailable: 503,
  forbidden: 403,
};

function fail(c: Context, code: ErrorCode, message: string) {
  const body: ApiError = { code, message };
  return c.json(body, STATUS_BY_CODE[code]);
}

function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

function isCrossSite(c: Context): boolean {
  return isCrossSiteRequest({
    secFetchSite: c.req.header('sec-fetch-site'),
    origin: c.req.header('origin'),
    host: c.req.header('host'),
  });
}

function extensionOf(filename: string): string {
  return filename.slice(filename.lastIndexOf('.')).toLowerCase();
}

async function withTempFile<T>(extension: string, bytes: Uint8Array, use: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'distill-'));
  try {
    const path = join(dir, `input${extension}`);
    await writeFile(path, bytes);
    return await use(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isUploadedFile(value: unknown): value is File {
  return typeof value === 'object' && value !== null && typeof (value as File).arrayBuffer === 'function' && typeof (value as File).name === 'string';
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const tooLarge = () => `File exceeds the ${deps.maxBytes} byte limit`;

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  if (deps.guardLoopback) {
    const blocked = (c: Context) => fail(c, 'forbidden', 'Request blocked: distill only accepts local requests');
    app.use('*', async (c, next) => {
      if (!isLoopbackHost(hostnameOf(c.req.header('host') ?? ''))) return blocked(c);
      const origin = c.req.header('origin');
      if (!SAFE_METHODS.has(c.req.method) && origin !== undefined) {
        const hostname = originHostname(origin);
        if (hostname === null || !isLoopbackHost(hostname)) return blocked(c);
      }
      return next();
    });
  } else {
    app.use('*', async (c, next) => {
      if (!isAllowedHost(hostnameOf(requestHost(c)), deps.allowedHosts)) return fail(c, 'forbidden', UNKNOWN_HOST_MESSAGE);
      return next();
    });
  }

  app.use('/api/*', async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && isCrossSite(c)) {
      return fail(c, 'forbidden', 'Request blocked: cross-site requests are not allowed');
    }
    return next();
  });

  app.onError((error, c) => {
    if (error instanceof DistillError) return fail(c, error.code, error.message);
    const body: ApiError = { code: 'parse_failed', message: 'Unexpected server error' };
    return c.json(body, 500);
  });

  app.get('/api/health', (c) => {
    const body: Health = {
      version: deps.version,
      liteparseVersion: deps.liteparseVersion,
      libreoffice: deps.libreoffice,
      lingua: deps.lingua.status(),
      maxBytes: deps.maxBytes,
    };
    return c.json(body);
  });

  app.post(
    '/api/parse',
    bodyLimit({ maxSize: deps.maxBytes + MULTIPART_OVERHEAD_BYTES, onError: (c) => fail(c, 'too_large', tooLarge()) }),
  );

  app.post('/api/parse', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return fail(c, 'bad_request', 'Expected multipart form data with a file field');
    }
    const file = form.get('file');
    if (!isUploadedFile(file)) return fail(c, 'bad_request', 'Missing file field');
    const kind = detectKind(file.name);
    if (!kind) return fail(c, 'unsupported_type', 'Unsupported file type');
    if (file.size > deps.maxBytes) return fail(c, 'too_large', tooLarge());
    if (needsLibreOffice(kind) && !deps.libreoffice) {
      return fail(c, 'needs_libreoffice', 'LibreOffice is required to read this file type');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const started = performance.now();
    const result = await withTempFile(extensionOf(file.name), bytes, (path) => deps.parser.toMarkdown(path));
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    const id = randomUUID();
    deps.store.put({ id, name: file.name, kind, bytes, markdown: result.markdown });
    const body: ParseResponse = {
      id,
      name: file.name,
      kind,
      pages: result.pages,
      markdown: result.markdown,
      ms: Math.round(performance.now() - started),
    };
    return c.json(body);
  });

  app.get('/api/files/:id/json', async (c) => {
    const stored = deps.store.get(c.req.param('id'));
    if (!stored) return fail(c, 'not_found', 'File not found');
    const json = await withTempFile(extensionOf(stored.name), stored.bytes, (path) => deps.parser.toJson(path));
    return c.json(json as object);
  });

  app.delete('/api/files/:id', (c) => {
    deps.store.delete(c.req.param('id'));
    return c.body(null, 204);
  });

  app.post(
    '/api/compress',
    async (c, next) => {
      if (!deps.lingua.status().installed) return fail(c, 'lingua_unavailable', 'LLMLingua-2 is not installed');
      return next();
    },
    bodyLimit({ maxSize: MAX_COMPRESS_BODY_BYTES, onError: (c) => fail(c, 'too_large', 'Request body is too large') }),
  );

  app.post('/api/compress', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return fail(c, 'bad_request', 'Invalid JSON body');
    }
    const { text, rate, model } = (payload ?? {}) as { text?: unknown; rate?: unknown; model?: unknown };
    if (typeof text !== 'string' || text.length > MAX_COMPRESS_CHARS) {
      return fail(c, 'bad_request', 'text must be a string of at most 5000000 characters');
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return fail(c, 'bad_request', 'rate must be a number');
    if (model !== undefined && (typeof model !== 'string' || !LINGUA_MODELS.has(model))) {
      return fail(c, 'bad_request', 'Unknown model');
    }
    try {
      const compressed = await deps.lingua.compress(text, {
        rate,
        model: model as LinguaModel | undefined,
        signal: c.req.raw.signal,
      });
      return c.json({ text: compressed });
    } catch (error) {
      if (error instanceof RangeError) return fail(c, 'bad_request', error.message);
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 });
      const status = deps.lingua.status();
      if (status.state === 'error') {
        return fail(c, 'lingua_unavailable', `Could not load the LLMLingua-2 model: ${status.modelError ?? 'unknown error'}`);
      }
      throw error;
    }
  });

  app.post('/api/lingua/install', (c) => {
    const before = deps.lingua.status();
    if (before.installed) return c.json(before);
    if (before.state === 'installing') return c.json(before, 202);
    if (!before.installable) return fail(c, 'lingua_unavailable', before.unsupportedReason ?? 'LLMLingua-2 cannot be installed here');
    deps.lingua.install().catch(() => undefined);
    return c.json(deps.lingua.status(), 202);
  });

  app.all('/api/*', (c) => fail(c, 'not_found', 'Not found'));

  if (deps.webRoot) {
    const root = deps.webRoot;
    app.use('/*', serveStatic({ root }));
    app.get('/*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
