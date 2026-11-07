import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    allowedHosts?: string[];
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
    status: () => ({ installed: opts.installed ?? false, installable: true, model: 'tinybert', state: 'idle', progress: 0 }),
    async probe() {
      return opts.installed ?? false;
    },
    async install() {},
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
    allowedHosts: opts.allowedHosts ?? [],
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
      lingua: { installed: false, installable: true, model: 'tinybert', state: 'idle', progress: 0 },
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

  it('does not answer an aborted compress request with a 500 ApiError', async () => {
    const { app } = setup({
      installed: true,
      lingua: {
        async compress(_text, opts) {
          if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          return 'x';
        },
      },
    });
    const controller = new AbortController();
    controller.abort();
    const res = await app.request('/api/compress', { ...jsonPost({ text: 'hi', rate: 0.5 }), signal: controller.signal });
    expect([res.status, await res.clone().text()]).toEqual([499, '']);
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json');
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

  it('does not store a parse whose client went away while parsing', async () => {
    const controller = new AbortController();
    const { app, store } = setup({
      parser: {
        async toMarkdown() {
          controller.abort();
          return { markdown: '# Late', pages: 1 };
        },
      },
    });
    const put = vi.spyOn(store, 'put');
    const res = await app.request('/api/parse', { ...upload('a.pdf'), signal: controller.signal });
    expect(res.status).toBe(499);
    expect(put).not.toHaveBeenCalled();
    const follow = await app.request('/api/parse', upload('b.pdf'));
    const body = (await follow.json()) as ParseResponse;
    expect(store.get(body.id)).toBeDefined();
  });

  describe('DELETE /api/files', () => {
    const put = (store: ReturnType<typeof createStore>, id: string) =>
      store.put({ id, name: `${id}.pdf`, kind: 'PDF', bytes: new Uint8Array(1), markdown: id });

    it('removes one stored file with 204 and is idempotent', async () => {
      const { app, store } = setup();
      put(store, 'a');
      put(store, 'b');
      const first = await app.request('/api/files/a', { method: 'DELETE' });
      expect(first.status).toBe(204);
      expect(store.get('a')).toBeUndefined();
      expect(store.get('b')).toBeDefined();
      const second = await app.request('/api/files/a', { method: 'DELETE' });
      expect(second.status).toBe(204);
      const unknown = await app.request('/api/files/never-existed', { method: 'DELETE' });
      expect(unknown.status).toBe(204);
    });

    it('has no wildcard delete: DELETE /api/files is a 404 and keeps every stored file', async () => {
      const { app, store } = setup();
      put(store, 'a');
      put(store, 'b');
      const res = await app.request('/api/files', { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiError).code).toBe('not_found');
      expect(store.get('a')).toBeDefined();
      expect(store.get('b')).toBeDefined();
    });

    it.each(['/api/files/a'])('blocks DELETE %s with a foreign Origin', async (path) => {
      const { app, store } = setup({ guardLoopback: true });
      put(store, 'a');
      const res = await app.request(path, { method: 'DELETE', headers: { host: 'localhost:4321', origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(store.get('a')).toBeDefined();
    });

    it('blocks DELETE with a foreign Host', async () => {
      const { app, store } = setup({ guardLoopback: true });
      put(store, 'a');
      const res = await app.request('/api/files/a', { method: 'DELETE', headers: { host: 'evil.example:4321' } });
      expect(res.status).toBe(403);
      expect(store.get('a')).toBeDefined();
    });

    it('allows DELETE with a loopback Origin', async () => {
      const { app, store } = setup({ guardLoopback: true });
      put(store, 'a');
      const res = await app.request('/api/files/a', { method: 'DELETE', headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' } });
      expect(res.status).toBe(204);
      expect(store.get('a')).toBeUndefined();
    });
  });

  describe('Cache-Control', () => {
    it.each([
      ['GET', '/api/health', undefined],
      ['GET', '/api/files/nope/json', undefined],
      ['GET', '/api/unknown', undefined],
      ['DELETE', '/api/files/a', undefined],
      ['POST', '/api/parse', 'bad'],
      ['POST', '/api/compress', 'bad'],
    ])('sets no-store on %s %s', async (method, path, kind) => {
      const { app } = setup({ installed: true });
      const init: RequestInit =
        kind === 'bad' ? { method, headers: { 'content-type': 'application/json' }, body: '{' } : { method };
      const res = await app.request(path, init);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('sets no-store on a successful parse and on a 500', async () => {
      const ok = setup();
      expect((await ok.app.request('/api/parse', upload('a.pdf'))).headers.get('cache-control')).toBe('no-store');
      const broken = setup({
        parser: {
          async toMarkdown() {
            throw new Error('boom');
          },
        },
      });
      const res = await broken.app.request('/api/parse', upload('a.pdf'));
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('sets no-store on blocked requests', async () => {
      const { app } = setup({ guardLoopback: true });
      const res = await app.request('/api/health', { headers: { host: 'evil.example:4321' } });
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('does not mark static files', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'distill-web-'));
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      const { app } = setup({ webRoot: dir });
      const res = await app.request('/');
      expect(res.headers.get('cache-control')).toBeNull();
    });
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

  });

  describe('host guard when exposed', () => {
    const blockedBody = {
      code: 'forbidden',
      message: 'Request blocked: unknown host. Allow it with --allowed-hosts or DISTILL_ALLOWED_HOSTS',
    };

    it.each(['/api/health', '/api/files/abc', '/'])('blocks a hostname that is not allowed on %s (DNS rebinding)', async (path) => {
      const { app } = setup({ guardLoopback: false });
      const res = await app.request(path, { headers: { host: 'evil.example:4321', origin: 'http://evil.example:4321', 'sec-fetch-site': 'same-origin' } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(blockedBody);
    });

    it.each(['localhost:4321', '127.0.0.1:4321', '[::1]:4321', '192.168.1.5:4321', '[fd00::5]:4321', '10.0.0.2'])(
      'allows loopback names and IP literals: %s',
      async (host) => {
        const { app } = setup({ guardLoopback: false });
        const res = await app.request('/api/health', { headers: { host } });
        expect(res.status).toBe(200);
      },
    );

    it('allows hostnames from allowedHosts, exact or by leading-dot suffix, ignoring case', async () => {
      const { app } = setup({ guardLoopback: false, allowedHosts: ['Distill.Home.Arpa', '.lan.example'] });
      for (const host of ['distill.home.arpa:4321', 'box.lan.example', 'lan.example:80']) {
        expect((await app.request('/api/health', { headers: { host } })).status).toBe(200);
      }
      for (const host of ['evil.home.arpa', 'notlan.example', 'lan.example.evil.com']) {
        expect((await app.request('/api/health', { headers: { host } })).status).toBe(403);
      }
    });

    it('treats an explicit default port in Host as the same origin', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ guardLoopback: false, allowedHosts: ['box.example'], lingua: { install } });
      const http = await app.request('/api/lingua/install', { method: 'POST', headers: { host: 'box.example:80', origin: 'http://box.example' } });
      expect(http.status).toBe(202);
      const https = await app.request('/api/lingua/install', { method: 'POST', headers: { host: 'box.example:443', origin: 'https://box.example' } });
      expect(https.status).not.toBe(403);
      const wrongDefault = await app.request('/api/lingua/install', { method: 'POST', headers: { host: 'box.example:443', origin: 'http://box.example' } });
      expect(wrongDefault.status).toBe(403);
    });
  });

  describe('cross-site guard', () => {
    const blockedBody = { code: 'forbidden', message: 'Request blocked: cross-site requests are not allowed' };
    const crossSite = { host: '192.168.1.5:4321', 'sec-fetch-site': 'cross-site' };
    const foreignOrigin = { host: '192.168.1.5:4321', origin: 'https://evil.example' };

    async function attempts(app: Harness['app'], headers: Record<string, string>) {
      const upload1 = upload('a.pdf');
      return [
        await app.request('/api/lingua/install', { method: 'POST', headers }),
        await app.request('/api/parse', { ...upload1, headers }),
        await app.request('/api/compress', { ...jsonPost({ text: 'x', rate: 0.5 }), headers: { ...headers, 'content-type': 'application/json' } }),
        await app.request('/api/files/abc', { method: 'DELETE', headers }),
        await app.request('/api/files/abc', { method: 'PUT', headers }),
        await app.request('/api/files/abc', { method: 'PATCH', headers }),
      ];
    }

    it.each([
      ['Sec-Fetch-Site cross-site', crossSite],
      ['a foreign Origin', foreignOrigin],
    ])('rejects every state-changing request with %s when the loopback guard is off', async (_label, headers) => {
      const install = vi.fn(async () => undefined);
      const { app, store } = setup({ installed: true, lingua: { install }, guardLoopback: false });
      const responses = await attempts(app, headers);
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual(blockedBody);
      }
      expect(install).not.toHaveBeenCalled();
      expect(store.get('abc')).toBeUndefined();
    });

    it('does not parse or install anything for a rejected request', async () => {
      const toMarkdown = vi.fn(async () => ({ markdown: 'x', pages: 1 }));
      const install = vi.fn(async () => undefined);
      const { app } = setup({ parser: { toMarkdown }, lingua: { install } });
      await attempts(app, foreignOrigin);
      expect(toMarkdown).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
    });

    it('allows a same-origin request, including its port', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ lingua: { install } });
      const res = await app.request('/api/lingua/install', {
        method: 'POST',
        headers: { host: '192.168.1.5:4321', origin: 'http://192.168.1.5:4321', 'sec-fetch-site': 'same-origin' },
      });
      expect(res.status).toBe(202);
      expect(install).toHaveBeenCalledTimes(1);
    });

    it('rejects an Origin whose port differs from the Host', async () => {
      const { app } = setup();
      const res = await app.request('/api/lingua/install', { method: 'POST', headers: { host: '192.168.1.5:4321', origin: 'http://192.168.1.5:9999' } });
      expect(res.status).toBe(403);
    });

    it('rejects an unparsable Origin', async () => {
      const { app } = setup();
      const res = await app.request('/api/lingua/install', { method: 'POST', headers: { host: '192.168.1.5:4321', origin: 'null' } });
      expect(res.status).toBe(403);
    });

    it('allows requests without Origin or Sec-Fetch-Site, such as curl or MCP clients', async () => {
      const { app } = setup();
      const res = await app.request('/api/parse', { ...upload('a.pdf'), headers: { host: '192.168.1.5:4321' } });
      expect(res.status).toBe(200);
      expect((await app.request('/api/files/abc', { method: 'DELETE', headers: { host: '192.168.1.5:4321' } })).status).toBe(204);
    });

    it('allows a same-site or user-initiated Sec-Fetch-Site', async () => {
      const { app } = setup();
      for (const site of ['same-origin', 'same-site', 'none']) {
        const res = await app.request('/api/files/abc', { method: 'DELETE', headers: { 'sec-fetch-site': site } });
        expect(res.status).toBe(204);
      }
    });

    it('leaves safe methods alone', async () => {
      const { app } = setup();
      const res = await app.request('/api/health', { headers: { host: '192.168.1.5:4321', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/lingua/install', () => {
    const statusWith = (state: 'idle' | 'installing', installed = false) => () => ({
      installed,
      installable: true,
      model: 'tinybert' as const,
      state,
      progress: 0,
    });

    it('starts the installation and answers 202 with the status', async () => {
      const install = vi.fn(async () => undefined);
      let installing = false;
      const { app } = setup({
        lingua: {
          install: async () => {
            installing = true;
            await install();
          },
          status: () => statusWith(installing ? 'installing' : 'idle')(),
        },
      });
      const res = await app.request('/api/lingua/install', { method: 'POST' });
      expect(res.status).toBe(202);
      expect(((await res.json()) as Health['lingua']).state).toBe('installing');
      expect(install).toHaveBeenCalledTimes(1);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('is idempotent while an installation is running', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ lingua: { install, status: statusWith('installing') } });
      const res = await app.request('/api/lingua/install', { method: 'POST' });
      expect(res.status).toBe(202);
      expect(install).not.toHaveBeenCalled();
    });

    it('is idempotent once LLMLingua-2 is installed', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ lingua: { install, status: statusWith('idle', true) } });
      const res = await app.request('/api/lingua/install', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Health['lingua']).installed).toBe(true);
      expect(install).not.toHaveBeenCalled();
    });

    it('answers 503 lingua_unavailable when installing is not possible here', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ lingua: { install, status: () => ({ installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 }) } });
      const res = await app.request('/api/lingua/install', { method: 'POST' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as ApiError).code).toBe('lingua_unavailable');
      expect(install).not.toHaveBeenCalled();
    });

    it('does not leak an installer failure and keeps the server alive', async () => {
      const install = vi.fn(async () => {
        throw new Error('npm exploded in /home/someone');
      });
      const { app } = setup({ lingua: { install } });
      const res = await app.request('/api/lingua/install', { method: 'POST' });
      expect(res.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await app.request('/api/health')).status).toBe(200);
    });

    it('rejects a foreign Origin with 403 and does not install', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ guardLoopback: true, lingua: { install } });
      const res = await app.request('/api/lingua/install', { method: 'POST', headers: { host: 'localhost:4321', origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(install).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback Host with 403', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ guardLoopback: true, lingua: { install } });
      const res = await app.request('/api/lingua/install', { method: 'POST', headers: { host: 'evil.example' } });
      expect(res.status).toBe(403);
      expect(install).not.toHaveBeenCalled();
    });

    it('accepts a loopback Origin', async () => {
      const install = vi.fn(async () => undefined);
      const { app } = setup({ guardLoopback: true, lingua: { install } });
      const res = await app.request('/api/lingua/install', { method: 'POST', headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' } });
      expect(res.status).toBe(202);
      expect(install).toHaveBeenCalledTimes(1);
    });

    it('does not take an install location from the request', async () => {
      const install = vi.fn(async (...args: unknown[]) => void args);
      const { app } = setup({ lingua: { install } });
      await app.request('/api/lingua/install?dir=/tmp/evil', { method: 'POST', body: JSON.stringify({ dir: '/tmp/evil' }), headers: { 'content-type': 'application/json' } });
      expect(install).toHaveBeenCalledWith();
    });
  });
});
