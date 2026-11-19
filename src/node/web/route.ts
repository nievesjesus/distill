import { detectKind } from '../../core/kind';

export type Route =
  | { type: 'html' }
  | { type: 'markdown' }
  | { type: 'document'; extension: string }
  | { type: 'unsupported'; contentType: string };

const DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'application/epub+zip': 'epub',
  'message/rfc822': 'eml',
  'application/vnd.ms-outlook': 'msg',
  'application/rss+xml': 'xml',
  'application/atom+xml': 'xml',
  'application/rdf+xml': 'xml',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

const HTML_TYPES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);
const MARKDOWN_TYPES: ReadonlySet<string> = new Set(['text/markdown', 'text/x-markdown', 'text/plain']);
const GENERIC_TYPES: ReadonlySet<string> = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const HTML_START = /^\s*(?:<!doctype\s+html|<html[\s>])/i;
const SNIFF_BYTES = 512;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function routeContent(contentType: string, url: string, body: Uint8Array): Route {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (HTML_TYPES.has(type)) return { type: 'html' };
  if (MARKDOWN_TYPES.has(type)) return { type: 'markdown' };
  const document = DOCUMENT_TYPES[type];
  if (document) return { type: 'document', extension: document };
  if (GENERIC_TYPES.has(type)) {
    const path = pathOf(url);
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (path.includes('.') && detectKind(path) !== null && detectKind(path) !== 'HTML') return { type: 'document', extension };
    if (HTML_START.test(Buffer.from(body.subarray(0, SNIFF_BYTES)).toString('latin1'))) return { type: 'html' };
  }
  return { type: 'unsupported', contentType: type };
}
