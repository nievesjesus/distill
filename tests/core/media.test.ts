import { describe, expect, it } from 'vitest';
import { slimMedia } from '@core/boosters/media';

describe('slimMedia', () => {
  it('turns images into bracketed alt text', () => {
    expect(slimMedia('![Figure 3: Revenue](./img/p14.png)')).toBe('[Figure 3: Revenue]');
  });

  it('drops images without alt text', () => {
    expect(slimMedia('a ![](./bg.png) b')).toBe('a  b');
  });

  it('keeps link text and drops the target', () => {
    expect(slimMedia('see [Exhibit A](https://x.com/a?id=1).')).toBe('see Exhibit A.');
  });

  it('leaves fenced code untouched', () => {
    expect(slimMedia('```\n![x](y)\n```')).toBe('```\n![x](y)\n```');
  });

  it('removes underline tags and keeps the inner text', () => {
    expect(slimMedia('published at <u>example.com/a.</u> today')).toBe('published at example.com/a. today');
  });

  it('removes underline tags regardless of case and spacing', () => {
    expect(slimMedia('<U>a</U> <u >b</u >')).toBe('a b');
  });

  it('removes underline tags inside a link', () => {
    expect(slimMedia('[<u>Exhibit A</u>](https://x.com/a)')).toBe('Exhibit A');
  });

  it('leaves underline tags inside fenced code untouched', () => {
    expect(slimMedia('```\n<u>x</u>\n```')).toBe('```\n<u>x</u>\n```');
  });

  it('is idempotent with underline tags', () => {
    const once = slimMedia('a <u>b</u> [<U>c</U>](d) <<u>u>');
    expect(slimMedia(once)).toBe(once);
  });
});
