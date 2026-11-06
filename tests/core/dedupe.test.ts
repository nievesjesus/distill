import { describe, expect, it } from 'vitest';
import { dropRepeatedBoilerplate } from '@core/boosters/dedupe';

describe('dropRepeatedBoilerplate', () => {
  it('keeps the first occurrence of a line repeated three or more times', () => {
    expect(dropRepeatedBoilerplate('X\nCONFIDENTIAL\nA\nCONFIDENTIAL\nB\nCONFIDENTIAL')).toBe('X\nCONFIDENTIAL\nA\nB');
  });

  it('treats lines differing only in digits as the same', () => {
    const doc = [
      'Example Co. — Report   Page 1 of 3',
      'Alpha',
      'Example Co. — Report   Page 2 of 3',
      'Beta',
      'Example Co. — Report   Page 3 of 3',
      'Gamma',
    ].join('\n');
    expect(dropRepeatedBoilerplate(doc)).toBe('Example Co. — Report   Page 1 of 3\nAlpha\nBeta\nGamma');
  });

  it('keeps lines that appear fewer than three times', () => {
    expect(dropRepeatedBoilerplate('A\nA\nB')).toBe('A\nA\nB');
  });

  it('never dedupes headings, list items or table rows', () => {
    expect(dropRepeatedBoilerplate('## H\n## H\n## H')).toBe('## H\n## H\n## H');
    expect(dropRepeatedBoilerplate('- a\n- a\n- a')).toBe('- a\n- a\n- a');
    expect(dropRepeatedBoilerplate('|a|\n|a|\n|a|')).toBe('|a|\n|a|\n|a|');
  });

  it('counts across prose segments but never touches fenced code', () => {
    const md = 'Footer\nx\n```\nFooter\n```\nFooter\ny\nFooter';
    expect(dropRepeatedBoilerplate(md)).toBe('Footer\nx\n```\nFooter\n```\ny');
  });

  it('is lossless for lines differing in non-page digits', () => {
    const q = 'Q1 results strong\nQ2 results strong\nQ3 results strong';
    expect(dropRepeatedBoilerplate(q)).toBe(q);
  });

  it('never counts pipe rows, ordered items or indented code', () => {
    const table = 'Name | Value\n--- | ---\nA | 1\nA | 2\nA | 3';
    expect(dropRepeatedBoilerplate(table)).toBe(table);
    expect(dropRepeatedBoilerplate('1) item\n1) item\n1) item')).toBe('1) item\n1) item\n1) item');
    const code = '    code();\n    code();\n    code();';
    expect(dropRepeatedBoilerplate(code)).toBe(code);
  });

  it('dedupes page indicators written as n/m', () => {
    const doc = 'Report — 3/14\nA\nReport — 4/14\nB\nReport — 5/14\nC';
    expect(dropRepeatedBoilerplate(doc)).toBe('Report — 3/14\nA\nB\nC');
  });

  it('compares lines after media slimming and keeps the original first line', () => {
    const doc = '[Edit this page](a.md)\nx\n[Edit this page](b.md)\ny\n[Edit this page](c.md)';
    expect(dropRepeatedBoilerplate(doc)).toBe('[Edit this page](a.md)\nx\ny');
  });
});
