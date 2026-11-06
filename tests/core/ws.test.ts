import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collapseWhitespace } from '@core/boosters/ws';

const mixed = readFileSync(new URL('../fixtures/mixed.md', import.meta.url), 'utf8');

describe('collapseWhitespace', () => {
  it('collapses blank lines, trailing spaces and inner space runs', () => {
    expect(collapseWhitespace('# A\n\n\n\nB  \nC   D')).toBe('# A\n\nB\nC D');
  });

  it('leaves fenced code untouched', () => {
    const md = 'a\n```\nx    y\n\n\n\n```';
    expect(collapseWhitespace(md)).toBe(md);
  });

  it('preserves leading indentation', () => {
    expect(collapseWhitespace('- item\n    - nested')).toBe('- item\n    - nested');
  });

  it('collapses inner spaces after the indentation', () => {
    expect(collapseWhitespace('    - a   b')).toBe('    - a b');
  });

  it('turns whitespace-only lines into empty lines', () => {
    expect(collapseWhitespace('a\n   \n\t\nb')).toBe('a\n\nb');
  });

  it('keeps the fence contents inside the mixed fixture', () => {
    const out = collapseWhitespace(mixed);
    expect(out).toContain('def  total(rows):\n\n\n\n    return  sum(r for r in rows)');
    expect(out).toContain('| a   | b   |\n|-----|-----|');
  });

  it('is idempotent', () => {
    const once = collapseWhitespace(mixed);
    expect(collapseWhitespace(once)).toBe(once);
    expect(once.length).toBeLessThan(mixed.length);
  });
});
