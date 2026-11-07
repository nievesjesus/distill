import { describe, expect, it } from 'vitest';
import { parseBoosterList } from '../../src/core/booster-list';

describe('parseBoosterList', () => {
  it('splits by comma and trims spaces', () => {
    expect(parseBoosterList('ws, tables')).toEqual(new Set(['ws', 'tables']));
  });

  it('returns an empty set for an empty value', () => {
    expect(parseBoosterList('')).toEqual(new Set());
  });

  it('ignores empty entries', () => {
    expect(parseBoosterList('ws,,dedupe,')).toEqual(new Set(['ws', 'dedupe']));
  });

  it('rejects unknown ids', () => {
    expect(() => parseBoosterList('ws,foo')).toThrow('Unknown booster: foo. Valid: dedupe, media, tables, ws');
  });
});
