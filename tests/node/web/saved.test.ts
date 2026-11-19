import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateSavings } from '../../../src/core/savings';
import { countTokens } from '../../../src/core/tokens';
import { createDistiller } from '../../../src/node/distill';
import type { Parser } from '../../../src/node/parse';
import { savedFormat, withSavedFormats } from '../../../src/node/web/saved';
import { makeEpub } from '../../fixtures/epub';

const html = readFileSync(join(__dirname, '../../fixtures/web/article.html'), 'utf8');
const NOW = () => new Date('2026-01-02T03:04:05Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-saved-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inner(): Parser & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async toMarkdown(path) {
      calls.push(path);
      return { markdown: '# inner\n', pages: 1, engine: 'liteparse' };
    },
    toJson: async () => ({ inner: true }),
    renderPage: async () => {
      throw new Error('unused');
    },
    close: () => {},
  };
}

function save(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const mhtml = (body: string, headers = ['Snapshot-Content-Location: https://blog.example.com/post/1']): string =>
  [
    'From: <Saved by Blink>',
    ...headers,
    'Subject: Saved page',
    'Date: Thu, 19 Nov 2026 10:00:00 -0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; type="text/html"; boundary="----MultipartBoundary--abc"',
    '',
    '------MultipartBoundary--abc',
    'Content-Type: text/html',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    body,
    '------MultipartBoundary--abc',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://blog.example.com/a.png',
    '',
    'iVBORw0KGgo=',
    '------MultipartBoundary--abc--',
    '',
  ].join('\r\n');

const mhtmlBody = `<html><head><title>Caf=C3=A9 post</title></head><body><article><h1>Caf=C3=A9 post</h1><p>${'Words about the caf=C3=A9 and its <a href=3D"/menu">menu</a> go here. '.repeat(10)}</p></article></body></html>`;

describe('savedFormat', () => {
  it.each([
    ['a.html', 'html'],
    ['a.HTM', 'html'],
    ['a.xhtml', 'html'],
    ['a.mhtml', 'mhtml'],
    ['a.mht', 'mhtml'],
    ['a.epub', 'epub'],
    ['a.eml', 'eml'],
    ['a.msg', 'msg'],
    ['a.xml', 'feed'],
    ['a.rss', 'feed'],
    ['a.atom', 'feed'],
  ])('maps %s to %s', (name, format) => {
    expect(savedFormat(name)).toBe(format);
  });

  it('ignores everything else', () => {
    expect(savedFormat('a.pdf')).toBeNull();
    expect(savedFormat('noext')).toBeNull();
  });
});

describe('withSavedFormats', () => {
  it('converts a saved html page and measures the raw page', async () => {
    const parser = withSavedFormats(inner(), { now: NOW });
    const result = await parser.toMarkdown(save('page.html', html));
    expect(result.engine).toBe('builtin');
    expect(result.pages).toBe(1);
    expect(result.rawTokens).toBe(countTokens(html));
    expect(result.markdown.split('\n')[0]).toBe('<!-- distill: page.html converted 2026-01-02T03:04:05.000Z; untrusted web content -->');
    expect(result.markdown).toContain('## Creating a widget');
    expect(result.markdown).not.toContain('DISPLAY-NONE-MARKER');
  });

  it('takes the base URL from <base href>', async () => {
    const page = `<html><head><title>T</title><base href="https://cdn.example.com/docs/"></head><body><article><h1>Base</h1><p>${'Read <a href="next">the next page</a> for details. '.repeat(15)}</p></article></body></html>`;
    const { markdown } = await withSavedFormats(inner(), { now: NOW }).toMarkdown(save('b.html', page));
    expect(markdown).toContain('(https://cdn.example.com/docs/next)');
  });

  it('decodes the charset declared in the page', async () => {
    const bytes = Buffer.concat([
      Buffer.from('<html><head><meta charset="shift_jis"><title>t</title></head><body><article><h1>'),
      Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]),
      Buffer.from(`</h1><p>${'plain words to give the article enough body text. '.repeat(10)}</p></article></body></html>`),
    ]);
    const { markdown } = await withSavedFormats(inner(), { now: NOW }).toMarkdown(save('jp.html', bytes));
    expect(markdown).toContain('日本語');
  });

  it('converts the whole saved page in full mode', async () => {
    const parser = withSavedFormats(inner(), { now: NOW });
    const path = save('full.html', html);
    const clean = await parser.toMarkdown(path);
    const full = await parser.toMarkdown(path, { mode: 'full' });
    expect(full.markdown).toContain('Getting started');
    expect(clean.markdown).not.toContain('Getting started');
    expect(full.markdown).not.toContain('DISPLAY-NONE-MARKER');
  });

  it('reads the html part of an MHTML snapshot and uses the original URL', async () => {
    const result = await withSavedFormats(inner(), { now: NOW }).toMarkdown(save('snap.mhtml', mhtml(mhtmlBody)));
    expect(result.markdown.split('\n')[0]).toBe('<!-- distill: https://blog.example.com/post/1 converted 2026-01-02T03:04:05.000Z; untrusted web content -->');
    expect(result.markdown).toContain('# Café post');
    expect(result.markdown).toContain('(https://blog.example.com/menu)');
    expect(result.rawTokens).toBeGreaterThan(0);
  });

  it('falls back to the file name for an MHTML without a snapshot location', async () => {
    const { markdown } = await withSavedFormats(inner(), { now: NOW }).toMarkdown(save('old.mht', mhtml(mhtmlBody, [])));
    expect(markdown.split('\n')[0]).toContain('distill: old.mht converted');
  });

  it('refuses an MHTML without an html page', async () => {
    const onlyImage = ['From: x', 'MIME-Version: 1.0', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgo=', ''].join('\r\n');
    await expect(withSavedFormats(inner(), { now: NOW }).toMarkdown(save('bad.mhtml', onlyImage))).rejects.toMatchObject({ code: 'parse_failed' });
  });

  it('reports an app shell saved as html', async () => {
    const shell = readFileSync(join(__dirname, '../../fixtures/web/shell.html'), 'utf8');
    await expect(withSavedFormats(inner(), { now: NOW }).toMarkdown(save('shell.html', shell))).rejects.toMatchObject({ code: 'needs_javascript' });
  });

  it('reads an epub, an eml and a feed', async () => {
    const parser = withSavedFormats(inner(), { now: NOW });
    const book = await parser.toMarkdown(save('b.epub', makeEpub({ chapters: [{ id: 'a', file: 'a.xhtml', title: 'One', body: '<p>Chapter one text.</p>' }] })));
    expect(book.markdown).toContain('## One');
    expect(book.rawTokens).toBeUndefined();
    const mail = await parser.toMarkdown(save('m.eml', 'From: a@example.com\r\nSubject: Hello\r\n\r\nBody.\r\n'));
    expect(mail.markdown).toContain('# Hello');
    const feed = await parser.toMarkdown(save('f.xml', '<rss version="2.0"><channel><title>F</title><item><title>E</title></item></channel></rss>'));
    expect(feed.markdown).toContain('## E');
  });

  it('hands everything else to the wrapped parser', async () => {
    const wrapped = inner();
    const parser = withSavedFormats(wrapped, { now: NOW });
    const result = await parser.toMarkdown('/x/report.pdf');
    expect(result).toEqual({ markdown: '# inner\n', pages: 1, engine: 'liteparse' });
    expect(await parser.toJson('/x/report.pdf')).toEqual({ inner: true });
    expect(wrapped.calls).toEqual(['/x/report.pdf']);
  });

  it('exposes json for saved formats', async () => {
    const json = (await withSavedFormats(inner(), { now: NOW }).toJson(save('page.html', html))) as { format: string; markdown: string };
    expect(json.format).toBe('html');
    expect(json.markdown).toContain('Widget API');
  });
});

describe('distillFile with saved formats', () => {
  function distiller() {
    return createDistiller({ parser: withSavedFormats(inner(), { now: NOW }), libreoffice: false, version: '0.0.0' });
  }

  it('reports html as HTML measured against the raw page', async () => {
    const result = await distiller().distillFile(save('page.html', html));
    expect(result.kind).toBe('HTML');
    expect(result.tokens.raw).toBe(countTokens(html));
    expect(result.tokens.out).toBeLessThan(result.tokens.raw);
    expect(estimateSavings(result).basis).toBe('raw-html');
  });

  it('reports the other formats with their own kinds', async () => {
    const d = distiller();
    expect((await d.distillFile(save('b.epub', makeEpub({ chapters: [{ id: 'a', file: 'a.xhtml', title: 'One', body: '<p>Text.</p>' }] })))).kind).toBe('EPUB');
    expect((await d.distillFile(save('m.eml', 'From: a@example.com\r\nSubject: Hi\r\n\r\nBody.\r\n'))).kind).toBe('EMAIL');
    expect((await d.distillFile(save('f.rss', '<rss version="2.0"><channel><title>F</title><item><title>E</title></item></channel></rss>'))).kind).toBe('FEED');
    expect((await d.distillFile(save('s.mht', mhtml(mhtmlBody)))).kind).toBe('HTML');
  });
});

describe('distillUrl with saved formats', () => {
  function over(contentType: string, finalUrl: string, body: Uint8Array | string) {
    return createDistiller({
      parser: withSavedFormats(inner(), { now: NOW }),
      libreoffice: false,
      version: '0.0.0',
      fetchUrl: async () => ({ finalUrl, status: 200, contentType, body: new Uint8Array(Buffer.from(body)), markdownServed: false }),
    });
  }

  it('converts an EPUB served at a URL', async () => {
    const book = makeEpub({ chapters: [{ id: 'a', file: 'a.xhtml', title: 'One', body: '<p>Chapter text.</p>' }] });
    const result = await over('application/epub+zip', 'https://books.example.com/b.epub', book).distillUrl('https://books.example.com/b.epub');
    expect(result.kind).toBe('EPUB');
    expect(result.markdown).toContain('## One');
    expect(result.path).toBe('https://books.example.com/b.epub');
  });

  it('converts a feed served as RSS', async () => {
    const xml = '<rss version="2.0"><channel><title>F</title><item><title>Entry</title><link>https://x.example/e</link></item></channel></rss>';
    const result = await over('application/rss+xml; charset=utf-8', 'https://x.example/feed', xml).distillUrl('https://x.example/feed');
    expect(result.kind).toBe('FEED');
    expect(result.markdown).toContain('- Link: https://x.example/e');
  });

  it('converts an email served as message/rfc822', async () => {
    const result = await over('message/rfc822', 'https://x.example/m', 'From: a@example.com\r\nSubject: Hi\r\n\r\nBody.\r\n').distillUrl('https://x.example/m');
    expect(result.kind).toBe('EMAIL');
  });
});
