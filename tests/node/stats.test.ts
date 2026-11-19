import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStats, recordUsage, renderStats, summarize } from '../../src/node/stats';

const SAVINGS = { baseline: 1000, out: 300, saved: 700, percent: 70, basis: 'raw-text' as const };
const at = (iso: string) => () => new Date(iso);

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'distill-stats-'));
}

describe('recordUsage', () => {
  it('appends one json line with only dates, source, kind and counts', () => {
    const cacheDir = join(dir(), 'cache');
    recordUsage({ source: 'hook', kind: 'PDF', savings: SAVINGS }, { cacheDir, env: {}, now: at('2026-11-19T10:00:00.000Z') });
    recordUsage({ source: 'mcp', kind: 'DOCX', savings: SAVINGS }, { cacheDir, env: {}, now: at('2026-11-19T11:00:00.000Z') });
    const file = join(cacheDir, 'stats.jsonl');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({ t: '2026-11-19T10:00:00.000Z', source: 'hook', kind: 'PDF', baseline: 1000, out: 300, saved: 700 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does nothing when DISTILL_NO_STATS is 1', () => {
    const cacheDir = dir();
    recordUsage({ source: 'cli', kind: 'PDF', savings: SAVINGS }, { cacheDir, env: { DISTILL_NO_STATS: '1' } });
    expect(existsSync(join(cacheDir, 'stats.jsonl'))).toBe(false);
  });

  it('rotates the file above 5 MB', () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, 'stats.jsonl'), 'x'.repeat(5 * 1024 * 1024 + 1));
    recordUsage({ source: 'cli', kind: 'PDF', savings: SAVINGS }, { cacheDir, env: {} });
    expect(statSync(join(cacheDir, 'stats.1.jsonl')).size).toBe(5 * 1024 * 1024 + 1);
    expect(readFileSync(join(cacheDir, 'stats.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('never throws', () => {
    const file = join(dir(), 'file');
    writeFileSync(file, '');
    expect(() => recordUsage({ source: 'cli', kind: 'PDF', savings: SAVINGS }, { cacheDir: join(file, 'nested'), env: {} })).not.toThrow();
  });
});

describe('readStats and summarize', () => {
  it('reads both files and skips bad lines', () => {
    const cacheDir = dir();
    const good = (t: string, source: string, saved: number) => JSON.stringify({ t, source, kind: 'PDF', baseline: saved * 2, out: saved, saved });
    writeFileSync(join(cacheDir, 'stats.1.jsonl'), `${good('2026-01-01T00:00:00.000Z', 'hook', 5)}\nnot json\n`);
    writeFileSync(join(cacheDir, 'stats.jsonl'), `${good('2026-11-18T00:00:00.000Z', 'mcp', 7)}\n{"t":1}\n`);
    expect(readStats(cacheDir).map((e) => e.saved)).toEqual([5, 7]);
  });

  it('returns an empty list when nothing exists', () => {
    expect(readStats(join(dir(), 'none'))).toEqual([]);
  });

  it('summarizes windows, sources and kinds', () => {
    const now = new Date('2026-11-19T12:00:00.000Z');
    const e = (t: string, source: 'hook' | 'mcp' | 'cli', kind: string, baseline: number, out: number) => ({ t, source, kind, baseline, out, saved: baseline - out });
    const s = summarize(
      [
        e('2026-11-18T12:00:00.000Z', 'hook', 'PDF', 1000, 300),
        e('2026-11-01T12:00:00.000Z', 'mcp', 'DOCX', 500, 100),
        e('2026-01-01T12:00:00.000Z', 'hook', 'PDF', 200, 100),
      ],
      now,
    );
    expect(s.all).toEqual({ count: 3, baseline: 1700, out: 500, saved: 1200 });
    expect(s.last30d).toEqual({ count: 2, baseline: 1500, out: 400, saved: 1100 });
    expect(s.last7d).toEqual({ count: 1, baseline: 1000, out: 300, saved: 700 });
    expect(s.bySource).toEqual({ hook: { count: 2, saved: 800 }, mcp: { count: 1, saved: 400 } });
    expect(s.byKind).toEqual({ PDF: { count: 2, saved: 800 }, DOCX: { count: 1, saved: 400 } });
  });
});

describe('renderStats', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');
  const entries = [{ t: '2026-11-18T12:00:00.000Z', source: 'hook' as const, kind: 'PDF', baseline: 1000, out: 300, saved: 700 }];

  it('prints totals, percent, sources and kinds', () => {
    const text = renderStats(summarize(entries, now));
    expect(text).toContain('All time: 1 conversions, 700 tokens saved (70%)');
    expect(text).toContain('Last 7 days: 1 conversions, 700 tokens saved (70%)');
    expect(text).toContain('hook: 1 conversions, 700 tokens saved');
    expect(text).toContain('PDF: 1 conversions, 700 tokens saved');
    expect(text).not.toContain('$');
  });

  it('adds a dollar value with a price', () => {
    expect(renderStats(summarize(entries, now), { price: 3 })).toContain('$0.0021');
  });

  it('says so when empty', () => {
    expect(renderStats(summarize([], now))).toContain('No conversions recorded yet');
  });
});
