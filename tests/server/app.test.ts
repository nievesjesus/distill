import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiError, Health, ParseResponse } from '../../src/core/types';
import { DistillError } from '../../src/node/errors';
import type { Lingua } from '../../src/node/lingua';
import type { Parser } from '../../src/node/parse';
import { createApp } from '../../src/server/app';
import { createStore } from '../../src/server/store';

interface Harness {
  app: ReturnType<typeof createApp>;
  paths: string[];
  jsonPaths: string[];
  store: ReturnType<typeof createStore>;
  lingua: Lingua;
}

function setup(
  opts: {
    parser?: Partial<Parser>;
    lingua?: Partial<Lingua>;
    installed?: boolean;
    maxBytes?: number;
    libreoffice?: boolean;
    webRoot?: string;
    guardLoopback?: boolean;
  } = {},
): Harness {
  const paths: string[] = [];
  const jsonPaths: string[] = [];
  const parser: Parser = {
    async toMarkdown(path) {
      paths.push(path);
      return { markdown: '# Hello', pages: 2 };
    },
    async toJson(path) {
      jsonPaths.push(path);
      return { pages: [{ n: 1 }] };
    },
    close() {},
    ...opts.parser,
  };
  const lingua: Lingua = {
    status: () => ({ installed: opts.installed ?? false, model: 'tinybert', state: 'idle', progress: 0 }),
    async probe() {
      return opts.installed ?? false;
    },
    async compress(text) {
      return text.toUpperCase();
    },
    ...opts.lingua,
  };
  const store = createStore({ maxFiles: 50, maxBytes: 1_000_000 });
  const app = createApp({
    parser,
    lingua,
    store,
    maxBytes: opts.maxBytes ?? 1_000_000,
    libreoffice: opts.libreoffice ?? false,
    version: '1.2.3',
    liteparseVersion: '4.5.6',
    webRoot: opts.webRoot,
    guardLoopback: opts.guardLoopback ?? false,
  });
  return { app, paths, jsonPaths, store, lingua };
}

function upload(name: string, content: string | Uint8Array = 'data', field = 'file'): RequestInit {
  const form = new FormData();
  form.append(field, new File([content as BlobPart], name));
  return { method: 'POST', body: form };
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

describe('server app', () => {
  it('GET /api/health returns capabilities', async () => {
    const { app } = setup({ maxBytes: 777 });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body).toEqual({
      version: '1.2.3',
      liteparseVersion: '4.5.6',
      libreoffice: false,
      lingua: { installed: false, model: 'tinybert', state: 'idle', progress: 0 },
      maxBytes: 777,
    });
  });

  it('POST /api/parse returns markdown and stores bytes', async () => {
    const { app, store } = setup();
    const res = await app.request('/api/parse', upload('report.pdf', 'abc'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseResponse;
    expect(body.markdown).toBe('# Hello');
    expect(body.kind).toBe('PDF');
    expect(body.pages).toBe(2);
    expect(body.name).toBe('report.pdf');
    expect(typeof body.ms).toBe('number');
    const stored = store.get(body.id);
    expect(stored).toBeDefined();
    expect(stored?.bytes.byteLength).toBe(3);
    expect(stored?.markdown).toBe('# Hello');
  });

  it('returns 400 bad_request when the file field is missing', async () => {
    const { app } = setup();
    const res = await app.request('/api/parse', upload('report.pdf', 'abc', 'other'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).code).toBe('bad_request');
  });

  it('returns 400 bad_request for a non-multipart body', async () => {
    const { app } = setup();
    const res = await app.request('/api/parse', jsonPost({}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).code).toBe('bad_request');
  });

  it('rejects unknown extension with 400 unsupported_type', async () => {
    const { app } = setup();
    const res = await app.request('/api/parse', upload('notes.exe'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).code).toBe('unsupported_type');
  });

  it('rejects > maxBytes with 413 too_large', async () => {
    const { app } = setup({ maxBytes: 10 });
    const res = await app.request('/api/parse', upload('big.pdf', new Uint8Array(11)));
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiError).code).toBe('too_large');
  });

  it('rejects early on an oversized Content-Length', async () => {
    const { app, paths } = setup({ maxBytes: 10 });
    const init = upload('big.pdf', 'x');
    const res = await app.request('/api/parse', {
      ...init,
      headers: { 'content-length': String(10 + 2 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiError).code).toBe('too_large');
    expect(paths).toHaveLength(0);
  });

  it('returns 422 needs_libreoffice for .docx when libreoffice=false', async () => {
    const { app } = setup({ libreoffice: false });
    const res = await app.request('/api/parse', upload('doc.docx'));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ApiError).code).toBe('needs_libreoffice');
  });

  it('parses .docx when libreoffice is available', async () => {
    const { app } = setup({ libreoffice: true });
    const res = await app.request('/api/parse', upload('doc.docx'));
    expect(res.status).toBe(200);
  });

  it.each([
    ['timeout', 504],
    ['password_protected', 422],
    ['parse_failed', 422],
  ] as const)('maps parser %s to %i', async (code, status) => {
    const { app } = setup({
      parser: {
        async toMarkdown() {
          throw new DistillError(code, 'boom');
        },
      },
    });
    const res = await app.request('/api/parse', upload('a.pdf'));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, message: 'boom' });
  });

  it('deletes the temp file after parsing, even on error', async () => {
    const ok = setup();
    await ok.app.request('/api/parse', upload('a.pdf'));
    expect(ok.paths).toHaveLength(1);
    expect(existsSync(ok.paths[0] as string)).toBe(false);
    expect(existsSync(join(ok.paths[0] as string, '..'))).toBe(false);

    const seen: string[] = [];
    const failing = setup({
      parser: {
        async toMarkdown(path) {
          seen.push(path);
          throw new DistillError('parse_failed', 'nope');
        },
      },
    });
    await failing.app.request('/api/parse', upload('a.pdf'));
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0] as string)).toBe(false);
    expect(existsSync(join(seen[0] as string, '..'))).toBe(false);
  });

  it('writes the upload to input<ext> and never uses the client name in the path', async () => {
    const { app, paths } = setup();
    await app.request('/api/parse', upload('Secret Name.PDF'));
    const path = paths[0] as string;
    expect(basename(path)).toBe('input.pdf');
    expect(path.startsWith(join(tmpdir(), 'distill-'))).toBe(true);
    expect(path).not.toContain('Secret');
  });

  it('stores a traversal filename safely', async () => {
    const { app, paths, store } = setup();
    const res = await app.request('/api/parse', upload('../../etc/evil.pdf'));
    expect(res.status).toBe(200);
    const path = paths[0] as string;
    expect(basename(path)).toBe('input.pdf');
    expect(path).not.toContain('..');
    expect(path).not.toContain('evil');
    const body = (await res.json()) as ParseResponse;
    expect(store.get(body.id)?.name).toBe(body.name);
  });

  it('returns 500 with a generic message and no paths on unexpected errors', async () => {
    const { app } = setup({
      parser: {
        async toMarkdown(path) {
          throw new Error(`ENOENT at ${path}`);
        },
      },
    });
    const res = await app.request('/api/parse', upload('a.pdf'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ code: 'parse_failed', message: 'Unexpected server error' });
    expect(text).not.toContain(tmpdir());
    expect(text).not.toContain('ENOENT');
  });

  it('GET /api/files/:id/json re-parses stored bytes; 404 for unknown id', async () => {
    const { app, jsonPaths } = setup();
    const parsed = (await (await app.request('/api/parse', upload('a.pdf', 'abc'))).json()) as ParseResponse;
    const res = await app.request(`/api/files/${parsed.id}/json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pages: [{ n: 1 }] });
    expect(basename(jsonPaths[0] as string)).toBe('input.pdf');
    expect(existsSync(jsonPaths[0] as string)).toBe(false);
    expect(existsSync(join(jsonPaths[0] as string, '..'))).toBe(false);

    const missing = await app.request('/api/files/nope/json');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).code).toBe('not_found');
  });

  it('cleans the temp dir when json parsing fails', async () => {
    const seen: string[] = [];
    const { app, store } = setup({
      parser: {
        async toJson(path) {
          seen.push(path);
          throw new DistillError('timeout', 'slow');
        },
      },
    });
    store.put({ id: 'x', name: 'a.pdf', kind: 'PDF', bytes: new Uint8Array(1), markdown: '' });
    const res = await app.request('/api/files/x/json');
    expect(res.status).toBe(504);
    expect(existsSync(seen[0] as string)).toBe(false);
  });

  it('POST /api/compress returns 503 when lingua not installed', async () => {
    const { app } = setup({ installed: false });
    const res = await app.request('/api/compress', jsonPost({ text: 'hi', rate: 0.5 }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).code).toBe('lingua_unavailable');
  });

  it('POST /api/compress returns compressed text', async () => {
    const { app } = setup({ installed: true });
    const res = await app.request('/api/compress', jsonPost({ text: 'hi', rate: 0.5 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'HI' });
  });

  it('maps a lingua RangeError to 400', async () => {
    const { app } = setup({
      installed: true,
      lingua: {
        async compress() {
          throw new RangeError('rate must be between 0.3 and 0.9');
        },
      },
    });
    const res = await app.request('/api/compress', jsonPost({ text: 'hi', rate: 0.1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).code).toBe('bad_request');
  });

  it.each([
    ['invalid json', '{nope'],
    ['missing text', { rate: 0.5 }],
    ['non-string text', { text: 5, rate: 0.5 }],
    ['missing rate', { text: 'hi' }],
    ['non-numeric rate', { text: 'hi', rate: 'x' }],
    ['oversized text', { text: 'a'.repeat(5_000_001), rate: 0.5 }],
  ])('rejects %s on /api/compress with 400', async (_label, body) => {
    const { app } = setup({ installed: true });
    const res = await app.request('/api/compress', jsonPost(body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).code).toBe('bad_request');
  });

  it('serves index.html for unknown non-api paths when webRoot set', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'distill-web-test-'));
    writeFileSync(join(webRoot, 'index.html'), '<html>spa</html>');
    writeFileSync(join(webRoot, 'app.js'), 'console.log(1)');
    const { app } = setup({ webRoot });
    const fallback = await app.request('/some/route');
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('spa');
    const asset = await app.request('/app.js');
    expect(await asset.text()).toContain('console.log');
    const api = await app.request('/api/unknown');
    expect(api.status).toBe(404);
    expect(((await api.json()) as ApiError).code).toBe('not_found');
  });

  it('returns 404 for unknown paths without webRoot', async () => {
    const { app } = setup();
    const res = await app.request('/anything');
    expect(res.status).toBe(404);
  });

  it('rejects a streamed multipart body without Content-Length over the limit', async () => {
    const { app, paths } = setup({ maxBytes: 10 });
    const form = new FormData();
    form.append('file', new File([new Uint8Array(3 * 1024 * 1024)], 'big.pdf'));
    const encoded = new Request('http://localhost/x', { method: 'POST', body: form });
    const contentType = encoded.headers.get('content-type') as string;
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 65536) controller.enqueue(bytes.slice(offset, offset + 65536));
        controller.close();
      },
    });
    const res = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiError).code).toBe('too_large');
    expect(paths).toHaveLength(0);
  });

  it('rejects an oversized compress body with 413', async () => {
    const { app } = setup({ installed: true });
    const res = await app.request('/api/compress', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': String(30_000_000) },
      body: 'x',
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiError).code).toBe('too_large');
  });

  it('returns 503 for compress without reading the body when lingua is missing', async () => {
    const { app } = setup({ installed: false });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('body was read');
      },
    });
    const res = await app.request('/api/compress', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(503);
  });

  describe('loopback guard', () => {
    const blockedBody = { code: 'forbidden', message: 'Request blocked: distill only accepts local requests' };

    it('blocks a foreign Host header', async () => {
      const { app } = setup({ guardLoopback: true });
      const res = await app.request('/api/health', { headers: { host: 'evil.example:4321' } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(blockedBody);
    });

    it.each(['localhost:5173', '127.0.0.1:4321', '[::1]:4321'])('allows Host %s', async (host) => {
      const { app } = setup({ guardLoopback: true });
      const res = await app.request('/api/health', { headers: { host } });
      expect(res.status).toBe(200);
    });

    it('blocks a POST with a foreign Origin', async () => {
      const { app } = setup({ guardLoopback: true });
      const init = upload('a.pdf');
      const res = await app.request('/api/parse', { ...init, headers: { host: 'localhost:4321', origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
    });

    it('allows a POST with a loopback Origin', async () => {
      const { app } = setup({ guardLoopback: true });
      const init = upload('a.pdf');
      const res = await app.request('/api/parse', { ...init, headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' } });
      expect(res.status).toBe(200);
    });

    it('allows a POST without Origin', async () => {
      const { app } = setup({ guardLoopback: true });
      const init = upload('a.pdf');
      const res = await app.request('/api/parse', { ...init, headers: { host: 'localhost:4321' } });
      expect(res.status).toBe(200);
    });

    it('allows any Host when guardLoopback is false', async () => {
      const { app } = setup({ guardLoopback: false });
      const res = await app.request('/api/health', { headers: { host: 'evil.example' } });
      expect(res.status).toBe(200);
    });
  });
});
