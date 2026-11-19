import { headingsOf, pageMarkersIn } from './outline';

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  context?: number;
  maxHits?: number;
}

export interface SearchHit {
  line: number;
  page?: number;
  section?: string;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  truncated: boolean;
}

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchQueryError';
  }
}

const DEFAULT_CONTEXT = 2;
const DEFAULT_MAX_HITS = 20;
const MAX_REGEX_LENGTH = 200;
const MAX_HIT_CHARS = 600;

interface Flat {
  text: string;
  starts: number[];
  lines: number[];
}

interface Window {
  from: number;
  to: number;
  first: number;
}

function flatten(lines: string[]): Flat {
  const markers = new Set(pageMarkersIn(lines.join('\n')).map((marker) => marker.line));
  const starts: number[] = [];
  const owners: number[] = [];
  const parts: string[] = [];
  let length = 0;
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (markers.has(line)) return;
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean === '') return;
    if (parts.length > 0) length += 1;
    starts.push(length);
    owners.push(line);
    parts.push(clean);
    length += clean.length;
  });
  return { text: parts.join(' '), starts, lines: owners };
}

function lineAt(flat: Flat, offset: number): number {
  let low = 0;
  let high = flat.starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (flat.starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return flat.lines[low];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looseSource(query: string, opts: SearchOptions): string {
  return opts.regex ? query : query.replace(/\s+/g, ' ').trim().split(' ').map(escapeRegex).join('\\s+');
}

function compile(query: string, opts: SearchOptions): RegExp {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  if (opts.regex) {
    if (query.length > MAX_REGEX_LENGTH) throw new SearchQueryError(`The regex is too long (${query.length} characters, the limit is ${MAX_REGEX_LENGTH})`);
    try {
      return new RegExp(query, flags);
    } catch (error) {
      throw new SearchQueryError(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (normalized === '') throw new SearchQueryError('The query is empty');
  return new RegExp(escapeRegex(normalized), flags);
}

function cap(text: string, anchor: number, matchLength: number): string {
  if (text.length <= MAX_HIT_CHARS) return text;
  const inner = MAX_HIT_CHARS - 2;
  const start = Math.max(0, Math.min(anchor - Math.floor(Math.max(0, inner - matchLength) / 2), text.length - inner));
  const adjusted = anchor + matchLength > start + inner ? anchor : start;
  const end = Math.min(text.length, adjusted + inner);
  return `${adjusted > 0 ? '…' : ''}${text.slice(adjusted, end)}${end < text.length ? '…' : ''}`;
}

function locate(text: string, lineOffset: number, loose: RegExp): { at: number; length: number } {
  const found = loose.exec(text.slice(lineOffset));
  return found ? { at: lineOffset + found.index, length: found[0].length } : { at: lineOffset, length: 0 };
}

function windowsOf(flat: Flat, pattern: RegExp, context: number, totalLines: number): Window[] {
  const windows: Window[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(flat.text)) !== null) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    const first = lineAt(flat, match.index);
    const last = lineAt(flat, match.index + match[0].length - 1);
    const from = Math.max(1, first - context);
    const to = Math.min(totalLines, last + context);
    const current = windows[windows.length - 1];
    if (current && from <= current.to + 1) current.to = Math.max(current.to, to);
    else windows.push({ from, to, first });
  }
  return windows;
}

export function searchMarkdown(markdown: string, query: string, opts: SearchOptions = {}): SearchResult {
  const pattern = compile(query, opts);
  const loose = new RegExp(looseSource(query, opts), opts.caseSensitive ? '' : 'i');
  const context = Math.max(0, Math.floor(opts.context ?? DEFAULT_CONTEXT));
  const maxHits = Math.max(1, Math.floor(opts.maxHits ?? DEFAULT_MAX_HITS));
  const lines = markdown.split('\n');
  const windows = windowsOf(flatten(lines), pattern, context, lines.length);
  const markers = pageMarkersIn(markdown);
  const headings = headingsOf(markdown);
  const hits = windows.slice(0, maxHits).map((window): SearchHit => {
    const page = markers.filter((marker) => marker.line <= window.first).length;
    const heading = [...headings].reverse().find((candidate) => candidate.line <= window.first);
    const body = lines.slice(window.from - 1, window.to);
    const lineOffset = body.slice(0, window.first - window.from).reduce((sum, row) => sum + row.length + 1, 0);
    const spot = locate(body.join('\n'), lineOffset, loose);
    return {
      line: window.first,
      ...(page > 0 ? { page } : {}),
      ...(heading ? { section: heading.title.replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '').trim() } : {}),
      text: cap(body.join('\n'), spot.at, spot.length),
    };
  });
  return { hits, total: windows.length, truncated: windows.length > hits.length };
}

export function renderHits(hits: SearchHit[]): string {
  return hits.map((hit) => `${hit.page === undefined ? '' : `p.${hit.page} `}L${hit.line}: ${hit.text.replace(/\n/g, '\n  ')}`).join('\n');
}
