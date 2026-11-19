import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SavingsEstimate } from '../core/savings';

export type StatsSource = 'hook' | 'mcp' | 'cli';

export interface StatsEntry {
  t: string;
  source: StatsSource;
  kind: string;
  baseline: number;
  out: number;
  saved: number;
}

export interface RecordDeps {
  cacheDir: string;
  env: Record<string, string | undefined>;
  now?: () => Date;
}

export interface Totals {
  count: number;
  baseline: number;
  out: number;
  saved: number;
}

export interface StatsSummary {
  all: Totals;
  last7d: Totals;
  last30d: Totals;
  bySource: Record<string, { count: number; saved: number }>;
  byKind: Record<string, { count: number; saved: number }>;
}

const FILE = 'stats.jsonl';
const ROTATED = 'stats.1.jsonl';
const MAX_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function recordUsage(entry: { source: StatsSource; kind: string; savings: SavingsEstimate }, deps: RecordDeps): void {
  try {
    if (deps.env.DISTILL_NO_STATS === '1') return;
    mkdirSync(deps.cacheDir, { recursive: true, mode: 0o700 });
    const file = join(deps.cacheDir, FILE);
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, join(deps.cacheDir, ROTATED));
    } catch {}
    const line: StatsEntry = {
      t: (deps.now ?? (() => new Date()))().toISOString(),
      source: entry.source,
      kind: entry.kind,
      baseline: entry.savings.baseline,
      out: entry.savings.out,
      saved: entry.savings.saved,
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
}

function isEntry(value: unknown): value is StatsEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.t === 'string' &&
    !Number.isNaN(Date.parse(v.t)) &&
    (v.source === 'hook' || v.source === 'mcp' || v.source === 'cli') &&
    typeof v.kind === 'string' &&
    typeof v.baseline === 'number' &&
    typeof v.out === 'number' &&
    typeof v.saved === 'number'
  );
}

function readFile(path: string): StatsEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: StatsEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {}
  }
  return entries;
}

export function readStats(cacheDir: string): StatsEntry[] {
  return [...readFile(join(cacheDir, ROTATED)), ...readFile(join(cacheDir, FILE))];
}

function totals(entries: StatsEntry[]): Totals {
  return entries.reduce(
    (sum, e) => ({ count: sum.count + 1, baseline: sum.baseline + e.baseline, out: sum.out + e.out, saved: sum.saved + e.saved }),
    { count: 0, baseline: 0, out: 0, saved: 0 },
  );
}

function group(entries: StatsEntry[], key: (e: StatsEntry) => string): Record<string, { count: number; saved: number }> {
  const result: Record<string, { count: number; saved: number }> = {};
  for (const e of entries) {
    const bucket = (result[key(e)] ??= { count: 0, saved: 0 });
    bucket.count += 1;
    bucket.saved += e.saved;
  }
  return result;
}

export function summarize(entries: StatsEntry[], now: Date): StatsSummary {
  const since = (days: number) => entries.filter((e) => now.getTime() - Date.parse(e.t) <= days * DAY_MS);
  return {
    all: totals(entries),
    last7d: totals(since(7)),
    last30d: totals(since(30)),
    bySource: group(entries, (e) => e.source),
    byKind: group(entries, (e) => e.kind),
  };
}

const format = (n: number): string => n.toLocaleString('en-US');

function totalsLine(label: string, t: Totals): string {
  const percent = t.baseline > 0 ? Math.round((t.saved / t.baseline) * 100) : 0;
  return `${label}: ${format(t.count)} conversions, ${format(t.saved)} tokens saved (${percent}%)`;
}

function groupLines(title: string, items: Record<string, { count: number; saved: number }>): string[] {
  const rows = Object.entries(items).sort((a, b) => b[1].saved - a[1].saved);
  return rows.length === 0 ? [] : ['', `${title}:`, ...rows.map(([name, v]) => `  ${name}: ${format(v.count)} conversions, ${format(v.saved)} tokens saved`)];
}

export function renderStats(summary: StatsSummary, opts: { price?: number } = {}): string {
  if (summary.all.count === 0) return 'No conversions recorded yet.';
  const lines = [totalsLine('All time', summary.all), totalsLine('Last 30 days', summary.last30d), totalsLine('Last 7 days', summary.last7d)];
  lines.push(...groupLines('By source', summary.bySource), ...groupLines('By kind', summary.byKind));
  if (opts.price !== undefined) {
    const dollars = (tokens: number) => `$${((tokens * opts.price!) / 1_000_000).toFixed(4)}`;
    lines.push('', `Value at $${opts.price} per million input tokens: ${dollars(summary.all.saved)} all time, ${dollars(summary.last30d.saved)} in 30 days, ${dollars(summary.last7d.saved)} in 7 days`);
  }
  return lines.join('\n');
}
