import { RE2JS, RE2JSException } from 're2js';
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

function looseSource(query: string): string {
  return query.replace(/\s+/g, ' ').trim().split(' ').map(escapeRegex).join('\\s+');
}

type Finder = (text: string, from: number) => { index: number; length: number } | null;

function nativeFinder(source: string, flags: string): Finder {
  const pattern = new RegExp(source, `${flags}g`);
  return (text, from) => {
    pattern.lastIndex = from;
    const found = pattern.exec(text);
    return found ? { index: found.index, length: found[0].length } : null;
  };
}

function re2Finder(query: string, caseSensitive: boolean): Finder {
  if (query.length > MAX_REGEX_LENGTH) throw new SearchQueryError(`The regex is too long (${query.length} characters, the limit is ${MAX_REGEX_LENGTH})`);
  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(query, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  } catch (error) {
    if (error instanceof RE2JSException) throw new SearchQueryError(`Invalid regex: ${error.message}`);
    throw error;
  }
  return (text, from) => {
    if (from > text.length) return null;
    const matcher = compiled.matcher(text);
    return matcher.find(from) ? { index: matcher.start(), length: matcher.end() - matcher.start() } : null;
  };
}

function compile(query: string, opts: SearchOptions): { all: Finder; loose: Finder } {
  const caseSensitive = opts.caseSensitive === true;
  if (opts.regex) {
    const finder = re2Finder(query, caseSensitive);
    return { all: finder, loose: finder };
  }
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (normalized === '') throw new SearchQueryError('The query is empty');
  const flags = caseSensitive ? '' : 'i';
  return { all: nativeFinder(escapeRegex(normalized), flags), loose: nativeFinder(looseSource(query), flags) };
}

function cap(text: string, anchor: number, matchLength: number): string {
  if (text.length <= MAX_HIT_CHARS) return text;
  const inner = MAX_HIT_CHARS - 2;
  const start = Math.max(0, Math.min(anchor - Math.floor(Math.max(0, inner - matchLength) / 2), text.length - inner));
  const adjusted = anchor + matchLength > start + inner ? anchor : start;
  const end = Math.min(text.length, adjusted + inner);
  return `${adjusted > 0 ? '…' : ''}${text.slice(adjusted, end)}${end < text.length ? '…' : ''}`;
}

function locate(text: string, lineOffset: number, loose: Finder): { at: number; length: number } {
  const found = loose(text, lineOffset);
  return found ? { at: found.index, length: found.length } : { at: lineOffset, length: 0 };
}

function windowsOf(flat: Flat, find: Finder, context: number, totalLines: number): Window[] {
  const windows: Window[] = [];
  let position = 0;
  let match: { index: number; length: number } | null;
  while ((match = find(flat.text, position)) !== null) {
    if (match.length === 0) {
      position = match.index + 1;
      continue;
    }
    position = match.index + match.length;
    const first = lineAt(flat, match.index);
    const last = lineAt(flat, match.index + match.length - 1);
    const from = Math.max(1, first - context);
    const to = Math.min(totalLines, last + context);
    const current = windows[windows.length - 1];
    if (current && from <= current.to + 1) current.to = Math.max(current.to, to);
    else windows.push({ from, to, first });
  }
  return windows;
}

export function searchMarkdown(markdown: string, query: string, opts: SearchOptions = {}): SearchResult {
  const { all, loose } = compile(query, opts);
  const context = Math.max(0, Math.floor(opts.context ?? DEFAULT_CONTEXT));
  const maxHits = Math.max(1, Math.floor(opts.maxHits ?? DEFAULT_MAX_HITS));
  const lines = markdown.split('\n');
  const windows = windowsOf(flatten(lines), all, context, lines.length);
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
