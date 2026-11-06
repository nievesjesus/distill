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
});
