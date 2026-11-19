import { countTokens } from './tokens';
import type { VisualKind, VisualPage } from './types';

export interface OutlineEntry {
  kind: 'heading' | 'page' | 'start';
  level: number;
  title: string;
  line: number;
  endLine: number;
  tokens: number;
  page?: string;
  visual?: VisualKind;
  visualPages?: VisualPage[];
}

export interface Outline {
  lines: number;
  tokens: number;
  entries: OutlineEntry[];
}

const DEFAULT_MAX_ENTRIES = 150;
const MAX_TITLE = 60;
const PAGE_MARKER = /^<!-- page (\S+?)(?:: (figure|scan) \([^)]*\))? -->$/;
const HEADING = /^(#{1,6})[ \t]+\S/;
const FENCE = /^\s{0,3}(```|~~~)/;
const TITLE_PREFIX = /^[#|\-*>\s]+/;

interface Heading {
  level: number;
  line: number;
  title: string;
}

interface Marker {
  line: number;
  label: string;
  visual?: VisualKind;
}

const EMPHASIS_PAIR = /\*\*|__/g;
const EMPHASIS_OPEN = /(^|[\s(])[*_]+(?=\S)/g;
const EMPHASIS_CLOSE = /(?<=\S)[*_]+(?=$|[\s).,;:!?])/g;

function stripEmphasis(text: string): string {
  return text.replace(EMPHASIS_PAIR, '').replace(EMPHASIS_OPEN, '$1').replace(EMPHASIS_CLOSE, '');
}

function cleanTitle(text: string): string {
  const cleaned = stripEmphasis(text.replace(TITLE_PREFIX, '')).trim();
  return cleaned.length > MAX_TITLE ? `${cleaned.slice(0, MAX_TITLE - 1)}…` : cleaned;
}

function tokensOf(lines: string[], from: number, to: number): number {
  return countTokens(lines.slice(from - 1, to).join('\n'));
}

function scan(lines: string[]): { headings: Heading[]; markers: Marker[] } {
  const headings: Heading[] = [];
  const markers: Marker[] = [];
  let fence: string | null = null;
  lines.forEach((text, index) => {
    const fenceMatch = FENCE.exec(text);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      return;
    }
    if (fence !== null) return;
    const marker = PAGE_MARKER.exec(text);
    if (marker) {
      markers.push({ line: index + 1, label: marker[1], ...(marker[2] ? { visual: marker[2] as VisualKind } : {}) });
      return;
    }
    const heading = HEADING.exec(text);
    if (heading) headings.push({ level: heading[1].length, line: index + 1, title: text.trim() });
  });
  return { headings, markers };
}

export function figurePagesIn(markdown: string): string[] {
  return scan(markdown.split('\n')).markers.filter((marker) => marker.visual === 'figure').map((marker) => marker.label);
}

function pageAt(markers: Marker[], line: number): string | undefined {
  let label: string | undefined;
  for (const marker of markers) {
    if (marker.line > line) break;
    label = marker.label;
  }
  return label;
}

function hasBody(lines: string[], from: number, to: number): boolean {
  for (let i = from; i <= to; i++) {
    if (lines[i - 1].trim() !== '' && !PAGE_MARKER.test(lines[i - 1])) return true;
  }
  return false;
}

function visualIn(lines: string[], markers: Marker[], from: number, to: number): VisualPage[] {
  const found: VisualPage[] = [];
  let current: Marker | undefined;
  for (const marker of markers) {
    if (marker.line > from) break;
    current = marker;
  }
  const inRange = markers.filter((marker) => marker.line > from && marker.line <= to && hasBody(lines, marker.line + 1, to));
  for (const marker of current ? [current, ...inRange] : inRange) {
    if (marker.visual) found.push({ page: marker.label, kind: marker.visual });
  }
  return found;
}

function headingEntries(lines: string[], headings: Heading[], markers: Marker[], maxLevel: number): OutlineEntry[] {
  const kept = headings.filter((heading) => heading.level <= maxLevel);
  return kept.map((heading, index) => {
    const next = kept.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLine = next ? next.line - 1 : lines.length;
    const page = pageAt(markers, heading.line);
    const visualPages = visualIn(lines, markers, heading.line, endLine);
    return {
      kind: 'heading',
      level: heading.level,
      title: heading.title,
      line: heading.line,
      endLine,
      tokens: tokensOf(lines, heading.line, endLine),
      ...(page === undefined ? {} : { page }),
      ...(visualPages.length > 0 ? { visualPages } : {}),
    };
  });
}

function pageTitle(lines: string[], from: number, to: number, label: string): string {
  for (let i = from; i <= to; i++) {
    const text = lines[i - 1];
    if (text.trim() === '' || PAGE_MARKER.test(text)) continue;
    const title = cleanTitle(text);
    if (title !== '') return title;
  }
  return `Page ${label}`;
}

function pageEntries(lines: string[], markers: Marker[], maxEntries: number): OutlineEntry[] {
  const size = Math.max(1, Math.ceil(markers.length / maxEntries));
  const entries: OutlineEntry[] = [];
  for (let start = 0; start < markers.length; start += size) {
    const group = markers.slice(start, start + size);
    const first = group[0];
    const last = group[group.length - 1];
    const following = markers[start + size];
    const endLine = following ? following.line - 1 : lines.length;
    const visualPages = group.flatMap((marker) => (marker.visual ? [{ page: marker.label, kind: marker.visual }] : []));
    entries.push({
      kind: 'page',
      level: 1,
      title: pageTitle(lines, first.line + 1, group.length === 1 ? endLine : markers[start + 1].line - 1, first.label),
      line: first.line,
      endLine,
      tokens: tokensOf(lines, first.line, endLine),
      page: group.length === 1 ? first.label : `${first.label}–${last.label}`,
      ...(group.length === 1 && first.visual ? { visual: first.visual } : {}),
      ...(group.length > 1 && visualPages.length > 0 ? { visualPages } : {}),
    });
  }
  return entries;
}

function hasBodyBefore(lines: string[], until: number): boolean {
  for (let i = 1; i < until; i++) {
    const text = lines[i - 1];
    if (text.trim() !== '' && !PAGE_MARKER.test(text)) return true;
  }
  return false;
}

export function buildOutline(markdown: string, opts: { maxEntries?: number } = {}): Outline {
  const maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const lines = markdown.split('\n');
  const { headings, markers } = scan(lines);
  const tokens = countTokens(markdown);
  let entries: OutlineEntry[];

  if (headings.filter((heading) => heading.level <= 3).length >= 2) {
    let maxLevel = 3;
    entries = headingEntries(lines, headings, markers, maxLevel);
    while (entries.length > maxEntries && maxLevel > 1) {
      maxLevel -= 1;
      entries = headingEntries(lines, headings, markers, maxLevel);
    }
  } else if (markers.length >= 2) {
    entries = pageEntries(lines, markers, maxEntries);
  } else {
    const first = lines.find((text) => text.trim() !== '' && !PAGE_MARKER.test(text));
    const title = first === undefined ? '' : cleanTitle(first);
    entries = [{ kind: 'heading', level: 1, title: title === '' ? '(untitled)' : title, line: 1, endLine: lines.length, tokens }];
  }

  const first = entries[0];
  if (first.line > 1 && hasBodyBefore(lines, first.line)) {
    entries.unshift({ kind: 'start', level: 1, title: '(beginning)', line: 1, endLine: first.line - 1, tokens: tokensOf(lines, 1, first.line - 1) });
  }
  return { lines: lines.length, tokens, entries };
}

function visualSummary(pages: VisualPage[] | undefined): string {
  if (!pages) return '';
  const list = (kind: VisualKind) => pages.filter((entry) => entry.kind === kind).map((entry) => entry.page);
  const figures = list('figure');
  const scans = list('scan');
  return `${figures.length > 0 ? ` · figures p.${figures.join(', ')}` : ''}${scans.length > 0 ? ` · scans p.${scans.join(', ')}` : ''}`;
}

const format = (n: number): string => n.toLocaleString('en-US');

export function renderOutline(outline: Outline, opts: { name?: string } = {}): string {
  const head = `Index of ${opts.name ?? 'document'}: ${format(outline.lines)} lines, ~${format(outline.tokens)} tokens (line numbers refer to this Markdown).`;
  const rows = outline.entries.map((entry) => {
    const indent = '  '.repeat(Math.max(0, entry.level - 1));
    const page = entry.page === undefined ? '' : ` · p.${entry.page}`;
    const visual = entry.visual ? ` · ${entry.visual}` : '';
    return `${indent}L${entry.line}-${entry.endLine} · ${format(entry.tokens)} tok${page}${visual}${visualSummary(entry.visualPages)} · ${entry.title}`;
  });
  return [head, ...rows].join('\n');
}

export function sliceLines(markdown: string, offset: number, limit?: number): { text: string; from: number; to: number; total: number } {
  const lines = markdown.split('\n');
  const total = lines.length;
  const from = Math.max(1, Math.floor(offset));
  const to = limit === undefined ? total : Math.min(total, from + Math.max(0, Math.floor(limit)) - 1);
  return { text: lines.slice(from - 1, Math.max(from - 1, to)).join('\n'), from, to, total };
}

export function fitLines(markdown: string, maxTokens: number): number {
  const lines = markdown.split('\n');
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokensOf(lines, 1, mid) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return low;
}
