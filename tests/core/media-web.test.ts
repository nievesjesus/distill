import { describe, expect, it } from 'vitest';
import { slimMedia } from '@core/boosters/media';

describe('slimMedia on web links', () => {
  it('drops a link title', () => {
    expect(slimMedia('[fetch()](https://developer.mozilla.org/en-US/docs/Web/API/fetch "fetch()") works')).toBe('fetch() works');
  });

  it('handles parentheses in the URL', () => {
    expect(slimMedia('see [Markdown](https://en.wikipedia.org/wiki/Markdown_(disambiguation)) now')).toBe('see Markdown now');
    expect(slimMedia('[Foo](https://en.wikipedia.org/wiki/Foo_(bar) "Foo (bar)").')).toBe('Foo.');
  });

  it('handles a linked image', () => {
    expect(slimMedia('[![Build status](https://ci.example/badge.svg)](https://ci.example/run/1)')).toBe('[Build status]');
  });

  it('drops an image with a title', () => {
    expect(slimMedia('![Logo](https://x.example/logo.png "The logo")')).toBe('[Logo]');
  });

  it('keeps bracketed text that is not a link', () => {
    expect(slimMedia('array[0] and [note] stay')).toBe('array[0] and [note] stay');
  });

  it('is idempotent on web output', () => {
    const once = slimMedia('[a](https://x.example/a_(b) "t") and [![i](https://x.example/i.png)](https://x.example)');
    expect(slimMedia(once)).toBe(once);
  });
});
