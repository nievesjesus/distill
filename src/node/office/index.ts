import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Parser } from '../parse';
import { readCsv } from './csv';
import { readDocx } from './docx';
import type { OfficeResult } from './markdown';
import { readPptx } from './pptx';
import { readXlsx } from './xlsx';

export type BuiltinOfficeType = 'docx' | 'xlsx' | 'pptx' | 'csv';

const TYPES: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx', 'csv']);

export function builtinOfficeType(name: string): BuiltinOfficeType | null {
  const ext = extname(name).slice(1).toLowerCase();
  return TYPES.has(ext) ? (ext as BuiltinOfficeType) : null;
}

async function read(type: BuiltinOfficeType, bytes: Uint8Array): Promise<OfficeResult> {
  switch (type) {
    case 'docx':
      return readDocx(bytes);
    case 'xlsx':
      return readXlsx(bytes);
    case 'pptx':
      return readPptx(bytes);
    case 'csv':
      return readCsv(bytes);
  }
}

export function withBuiltinOffice(
  parser: Parser,
  opts: { libreoffice: boolean; readFile?: (path: string) => Promise<Uint8Array> },
): Parser {
  const load = opts.readFile ?? readFile;
  return {
    async toMarkdown(path) {
      const type = opts.libreoffice ? null : builtinOfficeType(path);
      if (type === null) return { ...(await parser.toMarkdown(path)), engine: 'liteparse' };
      const { markdown, pages } = await read(type, await load(path));
      return { markdown, pages, engine: 'builtin' };
    },
    async toJson(path) {
      const type = opts.libreoffice ? null : builtinOfficeType(path);
      if (type === null) return parser.toJson(path);
      return (await read(type, await load(path))).json;
    },
    renderPage: (path, page, opts) => parser.renderPage(path, page, opts),
    close: () => parser.close(),
  };
}
