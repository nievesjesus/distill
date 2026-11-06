import { describe, expect, it } from 'vitest';
import { mapProse } from '@core/boosters/segments.js';

const up = (s: string) => s.toUpperCase();
const sample = [
  'Intro paragraph.',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'Outro.',
].join('\n');

describe('mapProse', () => {
  it('transforms prose only', () => expect(mapProse('a\n```\nb\n```\nc', up)).toBe('A\n```\nb\n```\nC'));
  it('protects tilde fences and longer fences', () =>
    expect(mapProse('x\n~~~~\n| a  |\n~~~~\ny', up)).toBe('X\n~~~~\n| a  |\n~~~~\nY'));
  it('protects leading front-matter', () =>
    expect(mapProse('---\ntitle: t\n---\nbody', up)).toBe('---\ntitle: t\n---\nBODY'));
  it('treats an unclosed fence as code to the end', () => expect(mapProse('a\n```\nb', up)).toBe('A\n```\nb'));
  it('is identity with identity fn', () => expect(mapProse(sample, (s) => s)).toBe(sample));
});
