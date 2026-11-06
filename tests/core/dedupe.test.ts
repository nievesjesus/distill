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
});
