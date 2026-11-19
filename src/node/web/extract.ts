import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { DistillError } from '../errors';
import { gfmTable } from '../office/markdown';

const MIN_WORDS = 50;
const SHELL_MAX_WORDS = 40;
const NEEDS_JAVASCRIPT =
  'This page needs JavaScript to show its content. Save it from your browser as .mhtml or .html (File > Save Page As) and convert the file instead';
const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d]))/i;
const NOISE = 'script, style, noscript, template';
const MOUNT = '#root, #__next, #app, #___gatsby, #__nuxt, #svelte, #react-root, [data-reactroot], app-root';

export interface Extracted {
  markdown: string;
  title: string;
  engine: 'defuddle' | 'readability' | 'turndown';
}

export interface DefuddleLike {
  (doc: Document, url: string, options: Record<string, unknown>): Promise<{ content: string; title?: string }>;
}

export interface ExtractDeps {
  defuddle?: DefuddleLike;
  now?: () => Date;
}

interface Prepared {
  document: Document;
  shell: boolean;
  words: number;
}

const words = (text: string): number => text.split(/\s+/).filter((part) => part !== '').length;

function parseDocument(html: string, url: string): Document {
  const { document } = parseHTML(html);
  const doc = document as unknown as { styleSheets?: unknown[]; URL: string; defaultView?: { getComputedStyle?: unknown } | null };
  if (!doc.styleSheets) doc.styleSheets = [];
  if (doc.defaultView && !doc.defaultView.getComputedStyle) doc.defaultView.getComputedStyle = () => ({ display: '' });
  doc.URL = url;
  return document as unknown as Document;
}

function baseOf(doc: Document, url: string): string {
  const href = doc.querySelector('base[href]')?.getAttribute('href');
  if (!href) return url;
  try {
    return new URL(href, url).href;
  } catch {
    return url;
  }
}

function absolutize(doc: Document, base: string): void {
  for (const [selector, attribute] of [
    ['a[href]', 'href'],
    ['img[src]', 'src'],
  ] as const) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const value = element.getAttribute(attribute);
      if (value === null || value.startsWith('#') || /^(?:javascript|data|mailto|tel):/i.test(value)) continue;
      try {
        element.setAttribute(attribute, new URL(value, base).href);
      } catch {}
    }
  }
}

function stripHidden(doc: Document): void {
  for (const element of Array.from(doc.querySelectorAll('[hidden], [aria-hidden="true"], input[type="hidden"]'))) element.remove();
  for (const element of Array.from(doc.querySelectorAll('[style]'))) {
    if (HIDDEN_STYLE.test(element.getAttribute('style') ?? '')) element.remove();
  }
}

function prepare(html: string, url: string): Prepared {
  const document = parseDocument(html, url);
  const scripts = document.querySelectorAll('script[src], script[type="module"]').length;
  const noscriptHint = Array.from(document.querySelectorAll('noscript')).some((node) => /javascript/i.test(node.textContent ?? ''));
  const mount = document.querySelector(MOUNT) !== null;
  for (const element of Array.from(document.querySelectorAll(NOISE))) element.remove();
  stripHidden(document);
  absolutize(document, baseOf(document, url));
  const count = words(document.body?.textContent ?? '');
  return { document, shell: count < SHELL_MAX_WORDS && (mount || scripts >= 2 || noscriptHint), words: count };
}

function cellText(node: { textContent: string | null }): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function turndown(): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  service.remove(['script', 'style', 'noscript', 'template', 'iframe']);
  service.remove((node: HTMLElement) => node.nodeName.toLowerCase() === 'svg');
  service.addRule('gfm-table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as unknown as { querySelectorAll(selector: string): ArrayLike<{ closest?: (selector: string) => unknown; querySelectorAll(selector: string): ArrayLike<{ textContent: string | null }> }> };
      const rows: string[][] = [];
      for (const row of Array.from(table.querySelectorAll('tr'))) {
        if (row.closest && row.closest('table') !== (node as unknown)) continue;
        rows.push(Array.from(row.querySelectorAll('th, td')).map(cellText));
      }
      const text = gfmTable(rows.filter((row) => row.length > 0));
      return text === '' ? '' : `\n\n${text}\n\n`;
    },
  });
  return service;
}

function withTitle(title: string, body: string): string {
  const heading = title.trim();
  if (heading === '' || /^#{1,6}[ \t]/.test(body.trimStart())) return body;
  return `# ${heading}\n\n${body}`;
}

function titleOf(doc: Document): string {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const heading = doc.querySelector('h1')?.textContent;
  return (og || heading || doc.title || '').replace(/\s+/g, ' ').trim();
}

const refuseFetch = (): Promise<Response> => Promise.reject(new Error('network access is disabled while extracting a page'));

async function viaDefuddle(html: string, url: string, run: DefuddleLike): Promise<Extracted | null> {
  try {
    const { document } = prepare(html, url);
    const result = await run(document, url, { markdown: true, useAsync: false, fetch: refuseFetch });
    const title = (result.title ?? '').trim() || titleOf(document);
    return { markdown: withTitle(title, result.content.trim()), title, engine: 'defuddle' };
  } catch {
    return null;
  }
}

function viaReadability(html: string, url: string): Extracted | null {
  try {
    const { document } = prepare(html, url);
    const article = new Readability(document).parse();
    if (!article?.content) return null;
    const title = (article.title ?? '').trim();
    return { markdown: withTitle(title, turndown().turndown(article.content).trim()), title, engine: 'readability' };
  } catch {
    return null;
  }
}

function wholePage(html: string, url: string): Extracted {
  const { document } = prepare(html, url);
  const title = titleOf(document);
  const body = turndown().turndown(document.body?.innerHTML ?? '').trim();
  return { markdown: withTitle(title, body), title, engine: 'turndown' };
}

export function sourceHeader(url: string, when: Date): string {
  return `<!-- distill: ${url.replace(/>/g, '%3E')} fetched ${when.toISOString()}; untrusted web content -->`;
}

export async function extractWeb(html: string, url: string, deps: ExtractDeps = {}): Promise<Extracted> {
  if (prepare(html, url).shell) throw new DistillError('needs_javascript', NEEDS_JAVASCRIPT);
  const run = deps.defuddle ?? (Defuddle as unknown as DefuddleLike);
  const primary = await viaDefuddle(html, url, run);
  let picked = primary !== null && words(primary.markdown) >= MIN_WORDS ? primary : null;
  if (picked === null) {
    const secondary = viaReadability(html, url);
    if (secondary !== null && words(secondary.markdown) >= MIN_WORDS) picked = secondary;
  }
  picked ??= wholePage(html, url);
  if (picked.markdown.trim() === '') throw new DistillError('parse_failed', 'The page has no readable text');
  return { ...picked, markdown: `${sourceHeader(url, (deps.now ?? (() => new Date()))())}\n\n${picked.markdown}\n` };
}

export async function htmlToMarkdown(html: string, url: string, deps: ExtractDeps = {}): Promise<string> {
  return (await extractWeb(html, url, deps)).markdown;
}
