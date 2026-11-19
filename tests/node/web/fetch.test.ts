import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DistillError } from '../../../src/node/errors';
import { decodeText, fetchUrl, isGlobalAddress } from '../../../src/node/web/fetch';
import type { Resolver, Transport, TransportRequest, TransportResponse } from '../../../src/node/web/fetch';

const PUBLIC_IP = '93.184.216.34';

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
  stream?: Readable;
}

function harness(routes: Record<string, Reply | ((req: TransportRequest) => Reply)>, dns: Record<string, string[]> = {}) {
  const lookups: string[] = [];
  const calls: TransportRequest[] = [];
  const resolve: Resolver = async (host) => {
    lookups.push(host);
    const found = dns[host];
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  };
  const transport: Transport = async (req) => {
    calls.push(req);
    const route = routes[req.url.href];
    if (!route) throw new Error(`no route for ${req.url.href}`);
    const reply = typeof route === 'function' ? route(req) : route;
    const body = reply.stream ?? Readable.from(reply.body === undefined ? [] : [Buffer.from(reply.body)]);
    const response: TransportResponse = { status: reply.status ?? 200, headers: reply.headers ?? { 'content-type': 'text/html' }, body };
    return response;
  };
  return { resolve, transport, lookups, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DistillError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('isGlobalAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::'])(
    'accepts %s',
    (address) => {
      expect(isGlobalAddress(address)).toBe(true);
    },
  );

  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '::ffff:0a00:0001',
    '::ffff:c0a8:1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '2001::1',
    '2001:db8::1',
    'not-an-ip',
  ])('rejects %s', (address) => {
    expect(isGlobalAddress(address)).toBe(false);
  });
});

describe('fetchUrl address checks', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'http://LOCALHOST:8080/admin',
    'http://127.1/',
    'http://0x7f.0.0.1/',
    'http://2130706433/',
    'http://017700000001/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:7f00:0001]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://10.0.0.1/',
    'http://100.64.0.1/',
    'http://172.16.5.5/',
    'http://192.168.1.1/',
    'http://198.18.0.1/',
    'http://0.0.0.0/',
    'http://224.0.0.1/',
  ])('refuses %s without connecting', async (url) => {
    const h = harness({}, { localhost: ['127.0.0.1', '::1'] });
    expect(await codeOf(fetchUrl(url, { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('forbidden');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a name that resolves to a private address', async () => {
    const h = harness({}, { 'internal.example.com': ['10.0.0.5'] });
    expect(await codeOf(fetchUrl('http://internal.example.com/', { resolve: h.resolve, transport: h.transport }))).toBe('forbidden');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a name when any of its addresses is not global', async () => {
    const h = harness({}, { 'mixed.example.com': [PUBLIC_IP, '10.0.0.5'] });
    expect(await codeOf(fetchUrl('http://mixed.example.com/', { resolve: h.resolve, transport: h.transport }))).toBe('forbidden');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a rebinding style name that resolves to loopback', async () => {
    const h = harness({}, { '127.0.0.1.nip.io': ['127.0.0.1'] });
    expect(await codeOf(fetchUrl('http://127.0.0.1.nip.io/', { resolve: h.resolve, transport: h.transport }))).toBe('forbidden');
  });

  it('refuses a name that does not resolve', async () => {
    const h = harness({}, {});
    expect(await codeOf(fetchUrl('http://nowhere.example.com/', { resolve: h.resolve, transport: h.transport }))).toBe('fetch_failed');
  });

  it('connects to the vetted address and resolves once per hop', async () => {
    const h = harness({ 'http://example.com/': { body: 'ok' } }, { 'example.com': [PUBLIC_IP] });
    await fetchUrl('http://example.com/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(h.lookups).toEqual(['example.com']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.addresses).toEqual([PUBLIC_IP]);
  });

  it('does not resolve an address literal', async () => {
    const h = harness({ 'http://93.184.216.34/': { body: 'ok' } });
    await fetchUrl('http://93.184.216.34/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(h.lookups).toEqual([]);
    expect(h.calls[0]?.addresses).toEqual(['93.184.216.34']);
  });

  it('allows private addresses only when asked', async () => {
    const h = harness({ 'http://localhost/': { body: 'ok' } }, { localhost: ['127.0.0.1'] });
    const result = await fetchUrl('http://localhost/', { resolve: h.resolve, transport: h.transport, allowPrivate: true, robotsPolicy: 'ignore' });
    expect(result.status).toBe(200);
    expect(h.calls[0]?.addresses).toEqual(['127.0.0.1']);
  });

  it('allows a listed host but not other private hosts', async () => {
    const h = harness(
      { 'http://intranet.corp/': { body: 'ok' } },
      { 'intranet.corp': ['10.1.2.3'], 'other.corp': ['10.1.2.4'] },
    );
    const options = { resolve: h.resolve, transport: h.transport, allowHosts: ['Intranet.corp'], robotsPolicy: 'ignore' as const };
    expect((await fetchUrl('http://intranet.corp/', options)).status).toBe(200);
    expect(await codeOf(fetchUrl('http://other.corp/', options))).toBe('forbidden');
  });
});

describe('fetchUrl schemes', () => {
  it.each(['file:///etc/passwd', 'data:text/html,hi', 'ftp://example.com/x', 'javascript:alert(1)', 'gopher://example.com/', 'not a url', ''])(
    'refuses %s',
    async (url) => {
      const h = harness({}, { 'example.com': [PUBLIC_IP] });
      expect(await codeOf(fetchUrl(url, { resolve: h.resolve, transport: h.transport }))).toBe('bad_request');
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each(['http://user:pass@example.com/', 'https://user@example.com/', 'http://:secret@example.com/'])('refuses credentials in %s', async (url) => {
    const h = harness({}, { 'example.com': [PUBLIC_IP] });
    expect(await codeOf(fetchUrl(url, { resolve: h.resolve, transport: h.transport }))).toBe('bad_request');
    expect(h.calls).toHaveLength(0);
  });
});

describe('fetchUrl redirects', () => {
  it('follows redirects and returns the final URL', async () => {
    const h = harness(
      {
        'http://a.example/start': { status: 301, headers: { location: '/next' } },
        'http://a.example/next': { status: 302, headers: { location: 'https://b.example/final' } },
        'https://b.example/final': { body: 'done' },
      },
      { 'a.example': [PUBLIC_IP], 'b.example': ['93.184.216.35'] },
    );
    const result = await fetchUrl('http://a.example/start', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(result.finalUrl).toBe('https://b.example/final');
    expect(Buffer.from(result.body).toString()).toBe('done');
    expect(h.lookups).toEqual(['a.example', 'a.example', 'b.example']);
  });

  it('re-checks every hop: a public page cannot redirect to a private address', async () => {
    const h = harness({ 'http://a.example/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } }, { 'a.example': [PUBLIC_IP] });
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('forbidden');
    expect(h.calls).toHaveLength(1);
  });

  it('re-checks every hop by name', async () => {
    const h = harness(
      { 'http://a.example/': { status: 307, headers: { location: 'http://metadata.example/' } } },
      { 'a.example': [PUBLIC_IP], 'metadata.example': ['169.254.169.254'] },
    );
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('forbidden');
    expect(h.calls).toHaveLength(1);
  });

  it('refuses a redirect to another scheme', async () => {
    const h = harness({ 'http://a.example/': { status: 302, headers: { location: 'file:///etc/passwd' } } }, { 'a.example': [PUBLIC_IP] });
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('bad_request');
  });

  it('refuses a redirect that adds credentials', async () => {
    const h = harness({ 'http://a.example/': { status: 302, headers: { location: 'http://u:p@a.example/x' } } }, { 'a.example': [PUBLIC_IP] });
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('bad_request');
  });

  function chain(hops: number): Record<string, Reply> {
    const routes: Record<string, Reply> = {};
    for (let i = 0; i < hops; i++) routes[`http://a.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    routes[`http://a.example/${hops}`] = { body: 'end' };
    return routes;
  }

  it('follows up to five redirects', async () => {
    const h = harness(chain(5), { 'a.example': [PUBLIC_IP] });
    const result = await fetchUrl('http://a.example/0', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(result.finalUrl).toBe('http://a.example/5');
  });

  it('stops after five redirects', async () => {
    const h = harness(chain(6), { 'a.example': [PUBLIC_IP] });
    expect(await codeOf(fetchUrl('http://a.example/0', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('fetch_failed');
  });

  it('fails on a redirect without a location', async () => {
    const h = harness({ 'http://a.example/': { status: 302 } }, { 'a.example': [PUBLIC_IP] });
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('fetch_failed');
  });
});

describe('fetchUrl limits', () => {
  const dns = { 'a.example': [PUBLIC_IP] };

  it('caps the body at maxBytes', async () => {
    const h = harness({ 'http://a.example/': { body: Buffer.alloc(2000, 97) } }, dns);
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, maxBytes: 1000, robotsPolicy: 'ignore' }))).toBe('too_large');
  });

  it('defaults to a 10 MB cap', async () => {
    const h = harness({ 'http://a.example/': { body: Buffer.alloc(10 * 1024 * 1024 + 1, 97) } }, dns);
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('too_large');
  });

  it('refuses early on a declared length over the cap', async () => {
    let read = false;
    const stream = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    const h = harness({ 'http://a.example/': { headers: { 'content-length': '999999999', 'content-type': 'text/html' }, stream } }, dns);
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('too_large');
    expect(read).toBe(false);
  });

  it('caps decoded bytes: a gzip bomb is refused', async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(200_000);
    const h = harness({ 'http://a.example/': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb } }, dns);
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('too_large');
  });

  it('decodes gzip within the cap', async () => {
    const h = harness({ 'http://a.example/': { headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, body: gzipSync('hello gzip') } }, dns);
    const result = await fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(Buffer.from(result.body).toString()).toBe('hello gzip');
  });

  it('times out when the server never answers', async () => {
    const transport: Transport = (req) =>
      new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const h = harness({}, dns);
    const started = Date.now();
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport, timeoutMs: 40, robotsPolicy: 'ignore' }))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('times out when the body stalls', async () => {
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from('partial'));
    const h = harness({ 'http://a.example/': { stream } }, dns);
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, timeoutMs: 40, robotsPolicy: 'ignore' }))).toBe('timeout');
  });
});

describe('fetchUrl request and response', () => {
  const dns = { 'a.example': [PUBLIC_IP] };

  it('asks for markdown first, identifies itself and sends no cookies or auth', async () => {
    const h = harness({ 'http://a.example/': { body: 'x' } }, dns);
    await fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, version: '1.2.3', robotsPolicy: 'ignore' });
    const headers = h.calls[0]?.headers ?? {};
    expect(headers.accept).toBe('text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8');
    expect(headers['user-agent']).toBe('distill-llm/1.2.3 (+https://github.com/nievesjesus/distill)');
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
  });

  it('reports markdown served, validators and the content type', async () => {
    const h = harness(
      { 'http://a.example/': { headers: { 'content-type': 'text/markdown; charset=utf-8', etag: '"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', 'cache-control': 'no-store' }, body: '# Hi' } },
      dns,
    );
    const result = await fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(result).toMatchObject({
      finalUrl: 'http://a.example/',
      status: 200,
      contentType: 'text/markdown; charset=utf-8',
      markdownServed: true,
      etag: '"abc"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      cacheControl: 'no-store',
    });
  });

  it('marks html as not markdown', async () => {
    const h = harness({ 'http://a.example/': { body: '<p>x</p>' } }, dns);
    const result = await fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(result.markdownServed).toBe(false);
  });

  it('sends validators for a conditional request and returns 304', async () => {
    const h = harness({ 'http://a.example/': { status: 304, headers: {} } }, dns);
    const result = await fetchUrl('http://a.example/', {
      resolve: h.resolve,
      transport: h.transport,
      etag: '"abc"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      robotsPolicy: 'ignore',
    });
    expect(result.status).toBe(304);
    expect(h.calls[0]?.headers['if-none-match']).toBe('"abc"');
    expect(h.calls[0]?.headers['if-modified-since']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
  });

  it('maps 404 to not_found and other errors to fetch_failed', async () => {
    const h = harness({ 'http://a.example/missing': { status: 404 }, 'http://a.example/boom': { status: 503 } }, dns);
    const options = { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' as const };
    expect(await codeOf(fetchUrl('http://a.example/missing', options))).toBe('not_found');
    expect(await codeOf(fetchUrl('http://a.example/boom', options))).toBe('fetch_failed');
  });

  it('wraps a transport failure', async () => {
    const h = harness({}, dns);
    expect(await codeOf(fetchUrl('http://a.example/', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' }))).toBe('fetch_failed');
  });
});

describe('fetchUrl robots.txt', () => {
  const dns = { 'a.example': [PUBLIC_IP] };

  it('refuses a disallowed path when respecting robots.txt', async () => {
    const h = harness(
      {
        'http://a.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' },
        'http://a.example/private/page': { body: 'secret' },
        'http://a.example/public': { body: 'open' },
      },
      dns,
    );
    const options = { resolve: h.resolve, transport: h.transport, robotsPolicy: 'respect' as const };
    expect(await codeOf(fetchUrl('http://a.example/private/page', options))).toBe('forbidden');
    expect((await fetchUrl('http://a.example/public', options)).status).toBe(200);
  });

  it('honours rules aimed at distill-llm', async () => {
    const h = harness(
      {
        'http://a.example/robots.txt': { body: 'User-agent: distill-llm\nDisallow: /\n' },
        'http://a.example/page': { body: 'x' },
      },
      dns,
    );
    expect(await codeOf(fetchUrl('http://a.example/page', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'respect' }))).toBe('forbidden');
  });

  it('ignores robots.txt when told to', async () => {
    const h = harness({ 'http://a.example/private': { body: 'x' } }, dns);
    const result = await fetchUrl('http://a.example/private', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'ignore' });
    expect(result.status).toBe(200);
    expect(h.calls.map((call) => call.url.pathname)).toEqual(['/private']);
  });

  it('allows everything when robots.txt is missing', async () => {
    const h = harness({ 'http://a.example/robots.txt': { status: 404 }, 'http://a.example/page': { body: 'x' } }, dns);
    expect((await fetchUrl('http://a.example/page', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'respect' })).status).toBe(200);
  });

  it('treats a server error on robots.txt as a full disallow', async () => {
    const h = harness({ 'http://a.example/robots.txt': { status: 503 }, 'http://a.example/page': { body: 'x' } }, dns);
    expect(await codeOf(fetchUrl('http://a.example/page', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'respect' }))).toBe('forbidden');
  });

  it('fetches robots.txt through the same address checks', async () => {
    const h = harness({ 'http://a.example/page': { body: 'x' } }, dns);
    await fetchUrl('http://a.example/page', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'respect' }).catch(() => {});
    expect(h.calls[0]?.addresses).toEqual([PUBLIC_IP]);
    expect(h.calls[0]?.url.pathname).toBe('/robots.txt');
  });

  it('checks robots.txt on the redirect target too', async () => {
    const h = harness(
      {
        'http://a.example/robots.txt': { status: 404 },
        'http://a.example/go': { status: 302, headers: { location: 'http://b.example/page' } },
        'http://b.example/robots.txt': { body: 'User-agent: *\nDisallow: /\n' },
        'http://b.example/page': { body: 'x' },
      },
      { 'a.example': [PUBLIC_IP], 'b.example': ['93.184.216.35'] },
    );
    expect(await codeOf(fetchUrl('http://a.example/go', { resolve: h.resolve, transport: h.transport, robotsPolicy: 'respect' }))).toBe('forbidden');
  });
});

describe('decodeText', () => {
  const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

  it('uses the charset from the header', () => {
    expect(decodeText(sjis, 'text/html; charset=Shift_JIS')).toBe('日本語');
  });

  it('falls back to a meta charset', () => {
    const html = Buffer.concat([Buffer.from('<html><head><meta charset="shift_jis"></head><body>'), sjis]);
    expect(decodeText(html, 'text/html')).toContain('日本語');
  });

  it('reads the http-equiv form of meta charset', () => {
    const html = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'), sjis]);
    expect(decodeText(html, undefined)).toContain('日本語');
  });

  it('prefers the header over the meta tag', () => {
    const html = Buffer.from('<meta charset="shift_jis">café', 'utf8');
    expect(decodeText(html, 'text/html; charset=utf-8')).toContain('café');
  });

  it('defaults to UTF-8', () => {
    expect(decodeText(Buffer.from('añadir 日本語'), 'text/html')).toBe('añadir 日本語');
  });

  it('respects a byte order mark', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), 'text/html')).toBe('hi');
  });

  it('survives an unknown charset label', () => {
    expect(decodeText(Buffer.from('hola'), 'text/html; charset=bogus-9')).toBe('hola');
  });
});

describe('default transport', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    return (server?.address() as AddressInfo).port;
  }

  it('connects to the vetted address without a second lookup', async () => {
    const port = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'x-host': String(req.headers.host) });
      res.end('<p>hi</p>');
    });
    const resolve: Resolver = async () => ['127.0.0.1'];
    const result = await fetchUrl(`http://pinned.invalid:${port}/x`, { resolve, allowHosts: ['pinned.invalid'], robotsPolicy: 'ignore' });
    expect(Buffer.from(result.body).toString()).toBe('<p>hi</p>');
  });

  it('decodes a compressed response from a real socket', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync('over the wire'));
    });
    const result = await fetchUrl(`http://127.0.0.1:${port}/`, { allowPrivate: true, robotsPolicy: 'ignore' });
    expect(Buffer.from(result.body).toString()).toBe('over the wire');
  });

  it('does not follow a redirect to a private address by default', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    const resolve: Resolver = async () => ['127.0.0.1'];
    const options = { resolve, allowHosts: ['pinned.invalid'], robotsPolicy: 'ignore' as const };
    expect(await codeOf(fetchUrl(`http://pinned.invalid:${port}/`, options))).toBe('forbidden');
  });

  it('times out against a real socket that never answers', async () => {
    const port = await listen(() => {});
    expect(await codeOf(fetchUrl(`http://127.0.0.1:${port}/`, { allowPrivate: true, timeoutMs: 80, robotsPolicy: 'ignore' }))).toBe('timeout');
  });
});
