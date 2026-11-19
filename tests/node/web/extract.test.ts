import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DistillError } from '../../../src/node/errors';
import { extractWeb, htmlToMarkdown } from '../../../src/node/web/extract';
import type { DefuddleLike } from '../../../src/node/web/extract';

const fixture = (name: string): string => readFileSync(join(__dirname, '../../fixtures/web', name), 'utf8');
const NOW = () => new Date('2026-01-02T03:04:05Z');
const URL_ARTICLE = 'https://docs.example.com/guide/widgets';
const MARKERS = ['ARIA-HIDDEN-MARKER', 'DISPLAY-NONE-MARKER', 'HIDDEN-ATTRIBUTE-MARKER', 'VISIBILITY-MARKER', 'FONT-SIZE-MARKER'];

const empty: DefuddleLike = async () => ({ content: '', title: '' });

describe('extractWeb with defuddle', () => {
  it('turns a documentation page into lean Markdown', async () => {
    const result = await extractWeb(fixture('article.html'), URL_ARTICLE, { now: NOW });
    expect(result.engine).toBe('defuddle');
    expect(result.title).toBe('Using the Widget API');
    const md = result.markdown;
    expect(md).toContain('# Using the Widget API');
    expect(md).toContain('## Creating a widget');
    expect(md).toContain('[REST interface](https://docs.example.com/reference/rest)');
    expect(md).toContain('![Request flow diagram](https://docs.example.com/img/diagram.png)');
    expect(md).toContain('```js\nconst res = await fetch(');
    expect(md).toContain('| Plan | Calls per minute | Widgets |');
    expect(md).toContain('| Team | 600 | 1,000 |');
    expect(md).toContain('- 429: slow down and retry later.');
  });

  it('drops navigation, banners and footers', async () => {
    const { markdown } = await extractWeb(fixture('article.html'), URL_ARTICLE, { now: NOW });
    for (const noise of ['We use cookies', 'Accept all', 'Pricing', 'Getting started', 'Copyright Example Inc', 'dataLayer', 'analytics.js']) {
      expect(markdown, noise).not.toContain(noise);
    }
  });

  it('strips hidden and aria-hidden text before extracting', async () => {
    const { markdown } = await extractWeb(fixture('article.html'), URL_ARTICLE, { now: NOW });
    for (const marker of MARKERS) expect(markdown, marker).not.toContain(marker);
  });

  it('prepends the source header with the fetch time', async () => {
    const { markdown } = await extractWeb(fixture('article.html'), URL_ARTICLE, { now: NOW });
    expect(markdown.split('\n')[0]).toBe(`<!-- distill: ${URL_ARTICLE} fetched 2026-01-02T03:04:05.000Z; untrusted web content -->`);
  });

  it('cannot close the header comment from the URL', async () => {
    const markdown = await htmlToMarkdown(fixture('article.html'), 'https://a.example/x?q=-->', { now: NOW });
    expect(markdown.split('\n')[0]).toBe('<!-- distill: https://a.example/x?q=--%3E fetched 2026-01-02T03:04:05.000Z; untrusted web content -->');
  });

  it('never lets the extractor reach the network', async () => {
    let seen: Record<string, unknown> = {};
    const spy: DefuddleLike = async (_doc, _url, options) => {
      seen = options;
      return { content: 'word '.repeat(80), title: 'T' };
    };
    await extractWeb(fixture('article.html'), URL_ARTICLE, { defuddle: spy, now: NOW });
    expect(seen.useAsync).toBe(false);
    expect(seen.markdown).toBe(true);
    await expect((seen.fetch as () => Promise<unknown>)()).rejects.toThrow(/network access is disabled/);
  });

  it('resolves links against the base href', async () => {
    const html = `<html><head><title>T</title><base href="https://cdn.example.com/docs/"></head><body><article><h1>Base</h1><p>${'Read the next <a href="page2">page</a> for more detail. '.repeat(12)}</p></article></body></html>`;
    const { markdown } = await extractWeb(html, 'https://example.com/start', { now: NOW });
    expect(markdown).toContain('(https://cdn.example.com/docs/page2)');
  });
});

describe('extractWeb fallbacks', () => {
  it('falls back to Readability when defuddle returns too little', async () => {
    const result = await extractWeb(fixture('article.html'), URL_ARTICLE, { defuddle: empty, now: NOW });
    expect(result.engine).toBe('readability');
    expect(result.markdown).toContain('## Creating a widget');
    expect(result.markdown).toContain('| Plan | Calls per minute | Widgets |');
    expect(result.markdown).toContain('| Scale | 6,000 | Unlimited |');
    expect(result.markdown).toContain('(https://docs.example.com/reference/rest)');
    for (const marker of MARKERS) expect(result.markdown, marker).not.toContain(marker);
  });

  it('falls back to Readability when defuddle throws', async () => {
    const boom: DefuddleLike = async () => {
      throw new Error('boom');
    };
    const result = await extractWeb(fixture('article.html'), URL_ARTICLE, { defuddle: boom, now: NOW });
    expect(result.engine).toBe('readability');
  });

  it('converts the whole page when nothing else finds an article', async () => {
    const result = await extractWeb(fixture('short.html'), 'https://example.com/', { defuddle: empty, now: NOW });
    expect(result.engine).toBe('turndown');
    expect(result.markdown).toContain('# Example Domain');
    expect(result.markdown).toContain('This domain is for use in illustrative examples');
    expect(result.markdown).toContain('[More information...](https://www.iana.org/domains/example)');
  });

  it('keeps a short real page', async () => {
    const result = await extractWeb(fixture('short.html'), 'https://example.com/', { now: NOW });
    expect(result.markdown).toContain('This domain is for use in illustrative examples');
  });

  it('refuses a page with no text at all', async () => {
    const error = await extractWeb('<html><body></body></html>', 'https://example.com/', { now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DistillError);
    expect((error as DistillError).code).toBe('parse_failed');
  });
});

describe('app shells', () => {
  it('reports a page that only mounts a JavaScript app', async () => {
    const error = await extractWeb(fixture('shell.html'), 'https://app.example.com/', { now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DistillError);
    expect((error as DistillError).code).toBe('needs_javascript');
    expect((error as DistillError).message).toContain('needs JavaScript');
    expect((error as DistillError).message).toContain('.mhtml or .html');
  });

  it('does not mistake a short static page for an app', async () => {
    const html = '<html><head><title>Hi</title><script src="/a.js"></script></head><body><h1>Hi</h1><p>Short but real.</p></body></html>';
    const result = await extractWeb(html, 'https://example.com/', { now: NOW });
    expect(result.markdown).toContain('Short but real.');
  });

  it('does not flag a long page that has a root element', async () => {
    const html = `<html><body><div id="root"><article><h1>Server rendered</h1><p>${'Plenty of rendered words here. '.repeat(30)}</p></article></div><script src="/a.js"></script><script src="/b.js"></script></body></html>`;
    const result = await extractWeb(html, 'https://example.com/', { now: NOW });
    expect(result.markdown).toContain('Plenty of rendered words');
  });
});
