import { describe, expect, it } from 'vitest';
import { wrapLongLines } from '../../src/core/wrap';

const sentence = (n: number): string => `Sentence number ${n} says something useful about the topic.`;

describe('wrapLongLines', () => {
  it('leaves short lines alone', () => {
    const text = '# Title\n\nshort line\n\n| a | b |';
    expect(wrapLongLines(text)).toBe(text);
  });

  it('splits a long line at the last sentence boundary before the limit', () => {
    const long = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
    const lines = wrapLongLines(long, 500).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(500);
    for (const line of lines.slice(0, -1)) expect(line.endsWith('.')).toBe(true);
    expect(lines.join(' ')).toBe(long);
  });

  it('falls back to the last space when there is no sentence boundary', () => {
    const long = Array.from({ length: 200 }, () => 'word').join(' ');
    const lines = wrapLongLines(long, 100).split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    expect(lines.join(' ')).toBe(long);
  });

  it('splits hard when there is no space', () => {
    const lines = wrapLongLines('x'.repeat(250), 100).split('\n');
    expect(lines.map((line) => line.length)).toEqual([100, 100, 50]);
  });

  it('never touches table rows', () => {
    const row = `| ${'cell '.repeat(500)}|`;
    expect(wrapLongLines(row, 100)).toBe(row);
  });

  it('never touches fenced code', () => {
    const text = `\`\`\`\n${'code '.repeat(100)}\n\`\`\`\n${'prose '.repeat(100)}`;
    const lines = wrapLongLines(text, 100).split('\n');
    expect(lines[1]).toBe('code '.repeat(100));
    expect(lines.slice(3).every((line) => line.length <= 100)).toBe(true);
    expect(lines.length).toBeGreaterThan(4);
  });

  it('is idempotent', () => {
    const long = Array.from({ length: 80 }, (_, i) => sentence(i)).join(' ');
    const once = wrapLongLines(long, 300);
    expect(wrapLongLines(once, 300)).toBe(once);
  });

  it('defaults to 1500 characters', () => {
    const long = Array.from({ length: 100 }, (_, i) => sentence(i)).join(' ');
    for (const line of wrapLongLines(long).split('\n')) expect(line.length).toBeLessThanOrEqual(1500);
  });
});
