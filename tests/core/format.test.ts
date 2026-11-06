import { describe, expect, it } from 'vitest';
import { savedPercent, shortCount } from '@core/format';
import { countTokens } from '@core/tokens';

describe('shortCount', () => {
  it('formats thousands and millions with one decimal', () => {
    expect(shortCount(38914)).toBe('38.9k');
    expect(shortCount(1000)).toBe('1.0k');
    expect(shortCount(2_400_000)).toBe('2.4M');
  });

  it('leaves numbers below 1000 as-is', () => {
    expect(shortCount(412)).toBe('412');
    expect(shortCount(0)).toBe('0');
  });
});

describe('savedPercent', () => {
  it('rounds the saved fraction to a percentage', () => {
    expect(savedPercent(100, 70)).toBe(30);
  });

  it('is 0 for empty input and never negative', () => {
    expect(savedPercent(0, 0)).toBe(0);
    expect(savedPercent(100, 130)).toBe(0);
  });
});

describe('countTokens', () => {
  it('counts tokens of text', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });
});
