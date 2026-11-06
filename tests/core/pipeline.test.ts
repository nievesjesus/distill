import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOSTERS, BOOSTER_ORDER, DEFAULT_ACTIVE, runBoosters } from '@core/boosters/pipeline';
import type { LocalBoosterId } from '@core/types';

const mixed = readFileSync(new URL('../fixtures/mixed.md', import.meta.url), 'utf8');
const WORD = /\p{L}[\p{L}\p{N}]*/gu;

function wordsOf(text: string): Set<string> {
  return new Set(text.match(WORD) ?? []);
}

describe('booster metadata', () => {
  it('lists boosters in display order with exact copy', () => {
    expect(BOOSTERS.map((b) => [b.id, b.name, b.hint, b.lossy, b.estimate])).toEqual([
      ['dedupe', 'Drop repeated boilerplate', 'running headers, page numbers', false, 0.09],
      ['media', 'Slim images and links', 'keep alt and link text', false, 0.05],
      ['tables', 'Compact tables', 'strip alignment padding', false, 0.14],
      ['ws', 'Collapse whitespace', 'blank lines, padding', false, 0.06],
      ['lingua', 'LLMLingua-2', 'lossy, local model', true, 0.45],
    ]);
    expect(BOOSTER_ORDER).toEqual(['dedupe', 'media', 'tables', 'ws']);
    expect([...DEFAULT_ACTIVE].sort()).toEqual([...BOOSTER_ORDER].sort());
  });
});

describe('runBoosters', () => {
  it('returns the input unchanged when nothing is active', () => {
    expect(runBoosters(mixed, new Set())).toBe(mixed);
  });

  it('applies boosters in fixed order regardless of Set order', () => {
    const a = runBoosters(mixed, new Set<LocalBoosterId>(['ws', 'dedupe']));
    const b = runBoosters(mixed, new Set<LocalBoosterId>(['dedupe', 'ws']));
    expect(a).toBe(b);
  });

  it('is idempotent with all boosters', () => {
    const once = runBoosters(mixed, DEFAULT_ACTIVE);
    expect(runBoosters(once, DEFAULT_ACTIVE)).toBe(once);
  });

  it('shrinks the fixture and keeps fenced code verbatim', () => {
    const out = runBoosters(mixed, DEFAULT_ACTIVE);
    expect(out.length).toBeLessThan(mixed.length);
    const fence = mixed.slice(mixed.indexOf('```python'), mixed.indexOf('```\n\nSee'));
    expect(out).toContain(fence);
  });

  it.each([
    '[Edit this page](https://gh/x/intro.md)\n\nA\n\n[Edit this page](https://gh/x/setup.md)\n\nB\n\n[Edit this page](https://gh/x/usage.md)',
    '![Logo](a.png)\n\nA\n\n![Logo](b.png)\n\nB\n\n![Logo](c.png)',
    [1, 2, 3]
      .map((n) => `[Edit this page](https://github.com/example-org/docs/blob/main/section-${n}/intro-and-overview.md)`)
      .join('\nx\n'),
    [1, 2, 3].map((n) => `Example Co. — Annual Report${' '.repeat(110)}Page ${n} of 3`).join('\nx\n'),
  ])('is idempotent when media makes lines identical', (doc) => {
    const once = runBoosters(doc, DEFAULT_ACTIVE);
    expect(runBoosters(once, DEFAULT_ACTIVE)).toBe(once);
  });

  it('normalizes CRLF to LF when a booster runs', () => {
    const out = runBoosters('a  b\r\n\r\n\r\nc\r\n', new Set<LocalBoosterId>(['ws']));
    expect(out).toBe('a b\n\nc\n');
  });

  it('keeps every alphanumeric word except URLs/paths and repeats', () => {
    const out = runBoosters(mixed, DEFAULT_ACTIVE);
    const expected = wordsOf(mixed.replace(/\]\([^)]*\)/g, ']'));
    const actual = wordsOf(out);
    const missing = [...expected].filter((word) => !actual.has(word));
    expect(missing).toEqual([]);
  });

  it('runs 2M chars under 1500ms', () => {
    const big = mixed.repeat(Math.ceil(2_000_000 / mixed.length));
    expect(big.length).toBeGreaterThanOrEqual(2_000_000);
    runBoosters(big, DEFAULT_ACTIVE);
    const timings = Array.from({ length: 3 }, () => {
      const started = performance.now();
      runBoosters(big, DEFAULT_ACTIVE);
      return performance.now() - started;
    });
    expect(Math.min(...timings)).toBeLessThan(1500);
  }, 30000);
});
