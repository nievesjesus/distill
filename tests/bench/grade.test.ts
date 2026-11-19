import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = () => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', 'grade.mjs')).href);

describe('extractAnswer', () => {
  it('takes the last ANSWER line', async () => {
    const { extractAnswer } = await load();
    expect(extractAnswer('ANSWER: 1\nmore text\nANSWER: 2')).toBe('2');
  });

  it('accepts markdown decoration and case', async () => {
    const { extractAnswer } = await load();
    expect(extractAnswer('**ANSWER:** 36 months')).toBe('36 months');
    expect(extractAnswer('answer: East')).toBe('East');
    expect(extractAnswer('- `ANSWER: SC-12`')).toBe('SC-12');
  });

  it('returns null without a usable line', async () => {
    const { extractAnswer } = await load();
    expect(extractAnswer('no answer here')).toBeNull();
    expect(extractAnswer('ANSWER:   ')).toBeNull();
    expect(extractAnswer(undefined)).toBeNull();
  });
});

describe('parseNumbers', () => {
  it('reads commas, currency, percent and decimals', async () => {
    const { parseNumbers } = await load();
    expect(parseNumbers('$74,580')).toContain(74580);
    expect(parseNumbers('3.1%')).toContain(3.1);
    expect(parseNumbers('-538,007')).toContain(-538007);
    expect(parseNumbers('37,365.44')).toContain(37365.44);
  });

  it('adds scaled values for k, M and B suffixes while keeping the raw number', async () => {
    const { parseNumbers } = await load();
    expect(parseNumbers('12.2 million')).toEqual(expect.arrayContaining([12.2, 12200000]));
    expect(parseNumbers('175B')).toEqual(expect.arrayContaining([175, 175e9]));
    expect(parseNumbers('4k')).toEqual(expect.arrayContaining([4, 4000]));
  });

  it('understands small number words', async () => {
    const { parseNumbers } = await load();
    expect(parseNumbers('six functions')).toContain(6);
  });
});

describe('gradeAnswer', () => {
  it('grades numbers with and without tolerance', async () => {
    const { gradeAnswer } = await load();
    expect(gradeAnswer('$25,450', { type: 'number', value: 25450 })).toBe(true);
    expect(gradeAnswer('25451', { type: 'number', value: 25450 })).toBe(false);
    expect(gradeAnswer('9.81', { type: 'number', value: 9.8, tolerance: 0.01 })).toBe(true);
    expect(gradeAnswer('9.9', { type: 'number', value: 9.8, tolerance: 0.01 })).toBe(false);
  });

  it('accepts an expected number inside a longer answer', async () => {
    const { gradeAnswer } = await load();
    expect(gradeAnswer('36 months (3 years)', { type: 'number', value: 36 })).toBe(true);
  });

  it('accepts answers given in the unit the question asked for', async () => {
    const { gradeAnswer } = await load();
    expect(gradeAnswer('175 billion', { type: 'number', value: 175 })).toBe(true);
    expect(gradeAnswer('$12.2 million', { type: 'number', value: 12.2 })).toBe(true);
  });

  it('matches text case- and space-insensitively', async () => {
    const { gradeAnswer } = await load();
    const expected = { type: 'text', value: 'Protection of Information at Rest' };
    expect(gradeAnswer('  protection   of information AT rest. ', expected)).toBe(true);
    expect(gradeAnswer('Protection of Information in Transit', expected)).toBe(false);
  });

  it('normalizes dashes and markdown in text', async () => {
    const { gradeAnswer } = await load();
    expect(gradeAnswer('**SC‑12**', { type: 'text', value: 'SC-12' })).toBe(true);
  });

  it('accepts any of several values for oneOf', async () => {
    const { gradeAnswer } = await load();
    const expected = { type: 'oneOf', value: ['American 11', 'AA11'] };
    expect(gradeAnswer('Flight AA11', expected)).toBe(true);
    expect(gradeAnswer('United 175', expected)).toBe(false);
  });

  it('grades facts by how many appear in the answer', async () => {
    const { gradeAnswer } = await load();
    const expected = { type: 'facts', value: ['2036', '174.70', 'Part B'], min: 2 };
    expect(gradeAnswer('The HI fund is depleted in 2036 and the premium is $174.70', expected)).toBe(true);
    expect(gradeAnswer('Depleted in 2036', expected)).toBe(false);
    expect(gradeAnswer('2036, 174.70, Part B', { ...expected, min: 3 })).toBe(true);
    expect(gradeAnswer('2036, 174.70', { ...expected, min: 3 })).toBe(false);
  });

  it('matches numeric facts across thousands separators and case', async () => {
    const { gradeAnswer, countFacts } = await load();
    expect(countFacts('Median income was $74,580', [74580, 'median'])).toBe(2);
    expect(countFacts('income 74580 dollars', ['74,580'])).toBe(1);
    expect(gradeAnswer('NOTHING relevant', { type: 'facts', value: ['a1', 'b2'], min: 1 })).toBe(false);
  });

  it('returns null when there is no answer', async () => {
    const { gradeAnswer } = await load();
    expect(gradeAnswer(null, { type: 'number', value: 1 })).toBeNull();
    expect(gradeAnswer('', { type: 'text', value: 'x' })).toBeNull();
  });
});

describe('gradeReply', () => {
  it('extracts and grades together', async () => {
    const { gradeReply } = await load();
    expect(gradeReply('Looking.\nANSWER: 48.2', { type: 'number', value: 48.2 })).toEqual({ answer: '48.2', correct: true });
    expect(gradeReply('No idea', { type: 'number', value: 1 })).toEqual({ answer: null, correct: null });
  });
});
