import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import PostalMime from 'postal-mime';
import { countTokens } from '../../core/tokens';
import { DistillError } from '../errors';
import type { Parser } from '../parse';
import { readEpub } from './epub';
import { extractWeb } from './extract';
import { decodeText } from './fetch';
import { readFeed } from './feed';
import { readEml, readMsg } from './mail';

export type SavedFormat = 'html' | 'mhtml' | 'epub' | 'eml' | 'msg' | 'feed';

const FORMATS: Record<string, SavedFormat> = {
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  mhtml: 'mhtml',
  mht: 'mhtml',
  epub: 'epub',
  eml: 'eml',
  msg: 'msg',
  xml: 'feed',
  rss: 'feed',
  atom: 'feed',
};

export function savedFormat(name: string): SavedFormat | null {
  return FORMATS[extname(name).slice(1).toLowerCase()] ?? null;
}

export interface SavedDeps {
  now?: () => Date;
  readFile?: (path: string) => Promise<Uint8Array>;
}

interface Read {
  markdown: string;
  pages: number;
  json: unknown;
  rawTokens?: number;
}

type Mode = 'clean' | 'full' | undefined;

async function readHtml(bytes: Uint8Array, label: string, now: () => Date, mode: Mode): Promise<Read> {
  const html = decodeText(bytes, undefined);
  const extracted = await extractWeb(html, 'about:blank', { now, verb: 'converted', label, ...(mode ? { mode } : {}) });
  return { markdown: extracted.markdown, pages: 1, rawTokens: countTokens(html), json: { format: 'html', title: extracted.title, markdown: extracted.markdown } };
}

async function readMhtml(bytes: Uint8Array, label: string, now: () => Date, mode: Mode): Promise<Read> {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(bytes);
  } catch (error) {
    throw new DistillError('parse_failed', 'Could not read the MHTML file', { cause: error });
  }
  const html = email.html ?? '';
  if (html.trim() === '') throw new DistillError('parse_failed', 'The MHTML file has no HTML page in it');
  const source = email.headers.find((header) => header.key === 'snapshot-content-location' || header.key === 'content-location')?.value.trim();
  const original = source && /^https?:\/\//i.test(source) ? source : null;
  const extracted = await extractWeb(html, original ?? 'about:blank', { now, verb: 'converted', label: original ?? label, ...(mode ? { mode } : {}) });
  return { markdown: extracted.markdown, pages: 1, rawTokens: countTokens(html), json: { format: 'mhtml', title: extracted.title, markdown: extracted.markdown } };
}

async function read(format: SavedFormat, bytes: Uint8Array, path: string, now: () => Date, mode?: Mode): Promise<Read> {
  const label = basename(path);
  switch (format) {
    case 'html':
      return readHtml(bytes, label, now, mode);
    case 'mhtml':
      return readMhtml(bytes, label, now, mode);
    case 'epub':
      return readEpub(bytes, { now, label });
    case 'eml':
      return readEml(bytes, { now, label });
    case 'msg':
      return readMsg(bytes, { now, label });
    case 'feed':
      return readFeed(bytes, { now, label });
  }
}

export function withSavedFormats(parser: Parser, deps: SavedDeps = {}): Parser {
  const load = deps.readFile ?? readFile;
  const now = deps.now ?? (() => new Date());
  return {
    async toMarkdown(path, opts) {
      const format = savedFormat(path);
      if (format === null) return parser.toMarkdown(path, opts);
      const { markdown, pages, rawTokens } = await read(format, await load(path), path, now, opts?.mode);
      return { markdown, pages, engine: 'builtin', ...(rawTokens === undefined ? {} : { rawTokens }) };
    },
    async toJson(path) {
      const format = savedFormat(path);
      if (format === null) return parser.toJson(path);
      return (await read(format, await load(path), path, now)).json;
    },
    renderPage: (path, page, opts) => parser.renderPage(path, page, opts),
    close: () => parser.close(),
  };
}
