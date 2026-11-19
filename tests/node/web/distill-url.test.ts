import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateSavings } from '../../../src/core/savings';
import { countTokens } from '../../../src/core/tokens';
import { createDistiller } from '../../../src/node/distill';
import { DistillError } from '../../../src/node/errors';
import type { Parser } from '../../../src/node/parse';
import type { FetchOptions, FetchResult } from '../../../src/node/web/fetch';

const html = readFileSync(join(__dirname, '../../fixtures/web/article.html'), 'utf8');
const shell = readFileSync(join(__dirname, '../../fixtures/web/shell.html'), 'utf8');
const URL_PAGE = 'https://docs.example.com/guide/widgets';
const T0 = Date.parse('2026-03-04T05:06:07Z');

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'distill-web-test-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function reply(over: Partial<FetchResult> & { text?: string | Buffer } = {}): FetchResult {
  const { text, ...rest } = over;
  return {
    finalUrl: URL_PAGE,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: new Uint8Array(Buffer.from(text ?? html)),
    markdownServed: false,
    ...rest,
  };
}

function setup(replies: FetchResult[] | ((url: string, options: FetchOptions) => FetchResult), opts: { cache?: boolean } = {}) {
  const calls: { url: string; options: FetchOptions }[] = [];
  const documents: { path: string; bytes: Buffer }[] = [];
  const parser: Parser = {
    async toMarkdown(path) {
      documents.push({ path, bytes: readFileSync(path) });
      return { markdown: '# From the PDF\n\nBody text.\n', pages: 2, engine: 'liteparse' };
    },
    toJson: async () => ({}),
    renderPage: async () => {
      throw new Error('unused');
    },
    close: () => {},
  };
  const queue = Array.isArray(replies) ? [...replies] : null;
  const clock = { now: T0 };
  const distiller = createDistiller({
    parser,
    libreoffice: false,
    version: '9.9.9',
    now: () => clock.now,
    ...(opts.cache === false ? {} : { webCacheDir: join(cacheDir, 'web') }),
    fetchUrl: async (url, options) => {
      calls.push({ url, options });
      if (queue) {
        const next = queue.shift();
        if (!next) throw new Error('no more replies');
        return next;
      }
      return (replies as (url: string, options: FetchOptions) => FetchResult)(url, options);
    },
  });
  return { distiller, calls, documents, clock };
}

describe('distillUrl for a web page', () => {
  it('returns lean Markdown with the raw page as the baseline', async () => {
    const { distiller } = setup([reply()]);
    const result = await distiller.distillUrl(URL_PAGE);
    expect(result.kind).toBe('HTML');
    expect(result.pages).toBe(1);
    expect(result.path).toBe(URL_PAGE);
    expect(result.name).toBe('Using the Widget API');
    expect(result.tokens.raw).toBe(countTokens(html));
    expect(result.tokens.out).toBe(countTokens(result.markdown));
    expect(result.tokens.out).toBeLessThan(result.tokens.raw / 1.5);
    expect(result.markdownServed).toBeUndefined();
    expect(estimateSavings(result).basis).toBe('raw-html');
  });

  it('marks the content as untrusted and slims links with the default boosters', async () => {
    const { distiller } = setup([reply()]);
    const { markdown } = await distiller.distillUrl(URL_PAGE);
    expect(markdown.split('\n')[0]).toBe(`<!-- distill: ${URL_PAGE} fetched 2026-03-04T05:06:07.000Z; untrusted web content -->`);
    expect(markdown).toContain('REST interface');
    expect(markdown).not.toContain('(https://docs.example.com/reference/rest)');
    expect(markdown).toContain('|Plan|Calls per minute|Widgets|');
  });

  it('keeps link targets when the media booster is off', async () => {
    const { distiller } = setup([reply()]);
    const { markdown } = await distiller.distillUrl(URL_PAGE, { boosters: new Set(['ws']) });
    expect(markdown).toContain('(https://docs.example.com/reference/rest)');
  });

  it('measures a page the server already sent as Markdown against that Markdown', async () => {
    const served = '# Title\n\nSome [link](https://x.example/a) text.\n';
    const { distiller } = setup([reply({ contentType: 'text/markdown; charset=utf-8', markdownServed: true, text: served })]);
    const result = await distiller.distillUrl(URL_PAGE);
    expect(result.markdownServed).toBe(true);
    expect(result.tokens.raw).toBe(countTokens(served));
    expect(result.markdown).toContain('untrusted web content');
    expect(result.markdown).toContain('Some link text.');
    expect(estimateSavings(result).basis).toBe('served-markdown');
  });

  it('treats plain text as served text', async () => {
    const { distiller } = setup([reply({ finalUrl: 'https://raw.example.com/README.txt', contentType: 'text/plain', text: 'just some words\n' })]);
    const result = await distiller.distillUrl('https://raw.example.com/README.txt');
    expect(result.markdownServed).toBe(true);
    expect(result.markdown).toContain('just some words');
    expect(result.name).toBe('README.txt');
  });

  it('reports an app shell as needs_javascript', async () => {
    const { distiller } = setup([reply({ text: shell })]);
    await expect(distiller.distillUrl('https://app.example.com/')).rejects.toMatchObject({ code: 'needs_javascript' });
  });

  it('refuses content it cannot read', async () => {
    const { distiller } = setup([reply({ contentType: 'application/json', text: '{}' })]);
    await expect(distiller.distillUrl(URL_PAGE)).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  it('refuses a bad URL before fetching', async () => {
    const { distiller, calls } = setup([]);
    await expect(distiller.distillUrl('ftp://example.com/x')).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('refuses lingua when it is not installed, before fetching', async () => {
    const { distiller, calls } = setup([reply()]);
    await expect(distiller.distillUrl(URL_PAGE, { lingua: true })).rejects.toMatchObject({ code: 'lingua_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('passes the safety options through and respects robots.txt by default', async () => {
    const { distiller, calls } = setup(() => reply());
    await distiller.distillUrl(URL_PAGE);
    await distiller.distillUrl(URL_PAGE, { robots: 'ignore', allowPrivate: true, allowHosts: ['intranet.corp'] });
    expect(calls[0]?.options).toMatchObject({ robotsPolicy: 'respect', version: '9.9.9' });
    expect(calls[0]?.options.allowPrivate).toBeUndefined();
    expect(calls[1]?.options).toMatchObject({ robotsPolicy: 'ignore', allowPrivate: true, allowHosts: ['intranet.corp'] });
  });

  it('propagates fetch errors', async () => {
    const { distiller } = setup(() => {
      throw new DistillError('forbidden', 'Refused: nope');
    });
    await expect(distiller.distillUrl(URL_PAGE)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('distillUrl for documents', () => {
  it('hands a PDF to the document distiller and cleans up', async () => {
    const pdf = Buffer.from('%PDF-1.7 fake');
    const { distiller, documents } = setup([reply({ finalUrl: 'https://files.example.com/reports/Q3%20report.pdf', contentType: 'application/pdf', text: pdf })]);
    const result = await distiller.distillUrl('https://files.example.com/reports/Q3%20report.pdf');
    expect(result.kind).toBe('PDF');
    expect(result.pages).toBe(2);
    expect(result.path).toBe('https://files.example.com/reports/Q3%20report.pdf');
    expect(result.name).toBe('Q3 report.pdf');
    expect(documents).toHaveLength(1);
    expect(documents[0]?.path.endsWith('.pdf')).toBe(true);
    expect(documents[0]?.bytes.equals(pdf)).toBe(true);
    expect(existsSync(documents[0]?.path as string)).toBe(false);
  });

  it('uses the extension when the server sends a generic type', async () => {
    const { distiller, documents } = setup([reply({ finalUrl: 'https://files.example.com/a/b.pdf', contentType: 'application/octet-stream', text: 'x' })]);
    await distiller.distillUrl('https://files.example.com/a/b.pdf');
    expect(documents[0]?.path.endsWith('.pdf')).toBe(true);
  });

  it('sniffs html behind a generic type', async () => {
    const { distiller } = setup([reply({ contentType: '', text: html })]);
    const result = await distiller.distillUrl(URL_PAGE);
    expect(result.kind).toBe('HTML');
  });
});

describe('distillUrl cache', () => {
  const stored = (): string[] => {
    const dir = join(cacheDir, 'web');
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
  };

  it('serves a fresh entry without touching the network', async () => {
    const { distiller, calls, clock } = setup([reply({ etag: '"v1"', cacheControl: 'max-age=60' })]);
    const first = await distiller.distillUrl(URL_PAGE);
    clock.now += 30_000;
    const second = await distiller.distillUrl(URL_PAGE);
    expect(calls).toHaveLength(1);
    expect(second.markdown).toBe(first.markdown);
    expect(second.tokens).toEqual(first.tokens);
  });

  it('revalidates with If-None-Match and reuses the entry on 304', async () => {
    const { distiller, calls, clock } = setup([
      reply({ etag: '"v1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT', cacheControl: 'max-age=60' }),
      reply({ status: 304, text: '', contentType: '' }),
    ]);
    const first = await distiller.distillUrl(URL_PAGE);
    clock.now += 120_000;
    const second = await distiller.distillUrl(URL_PAGE);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.etag).toBe('"v1"');
    expect(calls[1]?.options.lastModified).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
    expect(second.markdown).toBe(first.markdown);
  });

  it('replaces the entry when the page changed', async () => {
    const { distiller, clock } = setup([
      reply({ etag: '"v1"', cacheControl: 'max-age=1' }),
      reply({ etag: '"v2"', text: html.replace('Creating a widget', 'Making a widget') }),
    ]);
    await distiller.distillUrl(URL_PAGE);
    clock.now += 5000;
    const second = await distiller.distillUrl(URL_PAGE);
    expect(second.markdown).toContain('Making a widget');
  });

  it('honours no-store', async () => {
    const { distiller, calls } = setup(() => reply({ etag: '"v1"', cacheControl: 'no-store' }));
    await distiller.distillUrl(URL_PAGE);
    await distiller.distillUrl(URL_PAGE);
    expect(calls).toHaveLength(2);
    expect(stored()).toHaveLength(0);
  });

  it('does not cache a page that cannot be revalidated', async () => {
    const { distiller } = setup(() => reply());
    await distiller.distillUrl(URL_PAGE);
    expect(stored()).toHaveLength(0);
  });

  it('never caches or serves from the cache when private access was allowed', async () => {
    const { distiller, calls } = setup(() => reply({ etag: '"v1"', cacheControl: 'max-age=600' }));
    await distiller.distillUrl(URL_PAGE, { allowPrivate: true });
    expect(stored()).toHaveLength(0);
    await distiller.distillUrl(URL_PAGE);
    expect(stored()).toHaveLength(1);
    await distiller.distillUrl(URL_PAGE, { allowHosts: ['docs.example.com'] });
    expect(calls).toHaveLength(3);
  });

  it('keys on the boosters', async () => {
    const { distiller, calls } = setup(() => reply({ etag: '"v1"', cacheControl: 'max-age=600' }));
    await distiller.distillUrl(URL_PAGE);
    await distiller.distillUrl(URL_PAGE, { boosters: new Set(['ws']) });
    expect(calls).toHaveLength(2);
    expect(stored()).toHaveLength(2);
  });

  it('keys on the converter version', async () => {
    const one = setup(() => reply({ etag: '"v1"', cacheControl: 'max-age=600' }));
    await one.distiller.distillUrl(URL_PAGE);
    const parser: Parser = { toMarkdown: async () => ({ markdown: '', pages: 1 }), toJson: async () => ({}), renderPage: async () => { throw new Error('unused'); }, close: () => {} };
    const calls: string[] = [];
    const other = createDistiller({
      parser,
      libreoffice: false,
      version: '10.0.0',
      now: () => T0,
      webCacheDir: join(cacheDir, 'web'),
      fetchUrl: async (url) => {
        calls.push(url);
        return reply({ etag: '"v1"', cacheControl: 'max-age=600' });
      },
    });
    await other.distillUrl(URL_PAGE);
    expect(calls).toHaveLength(1);
  });

  it('survives a corrupt cache file', async () => {
    const { distiller, calls } = setup(() => reply({ etag: '"v1"', cacheControl: 'max-age=600' }));
    await distiller.distillUrl(URL_PAGE);
    const dir = join(cacheDir, 'web');
    const file = readdirSync(dir).find((name) => name.endsWith('.json')) as string;
    rmSync(join(dir, file));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, file), '{not json');
    const again = await distiller.distillUrl(URL_PAGE);
    expect(again.kind).toBe('HTML');
    expect(calls).toHaveLength(2);
  });

  it('works without a cache directory', async () => {
    const { distiller, calls } = setup(() => reply({ etag: '"v1"', cacheControl: 'max-age=600' }), { cache: false });
    await distiller.distillUrl(URL_PAGE);
    await distiller.distillUrl(URL_PAGE);
    expect(calls).toHaveLength(2);
  });
});
