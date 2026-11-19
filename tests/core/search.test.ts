import { describe, expect, it } from 'vitest';
import { renderHits, searchMarkdown } from '../../src/core/search';

const DOC = [
  '# Intro',
  '',
  '<!-- page 1 -->',
  'Welcome to the report.',
  'It covers revenue and costs.',
  '',
  '## Results',
  '<!-- page 2 -->',
  'Total revenue was 1,234',
  '567 dollars in the year,',
  'up from last year.',
  '',
  '<!-- page 3: figure (chart) -->',
  '### Outlook',
  'Costs will fall.',
  ...Array.from({ length: 20 }, (_, i) => `filler line ${i}`),
  'The word zebra appears here.',
  ...Array.from({ length: 20 }, (_, i) => `more filler ${i}`),
  'Another zebra at the end.',
].join('\n');

describe('searchMarkdown', () => {
  it('matches case-insensitively and reports line, page and section', () => {
    const out = searchMarkdown(DOC, 'WELCOME', { context: 0 });
    expect(out.total).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.hits[0]).toEqual({ line: 4, page: 1, section: 'Intro', text: 'Welcome to the report.' });
  });

  it('can be made case-sensitive', () => {
    expect(searchMarkdown(DOC, 'WELCOME', { caseSensitive: true }).total).toBe(0);
    expect(searchMarkdown(DOC, 'Welcome', { caseSensitive: true }).total).toBe(1);
  });

  it('finds numbers and phrases wrapped across lines', () => {
    const out = searchMarkdown(DOC, '1,234 567 dollars', { context: 0 });
    expect(out.total).toBe(1);
    expect(out.hits[0]).toMatchObject({ line: 9, page: 2, section: 'Results' });
    expect(out.hits[0].text).toContain('1,234');
    expect(out.hits[0].text).toContain('567 dollars');
  });

  it('normalizes whitespace in the query', () => {
    expect(searchMarkdown(DOC, '  total   revenue  ').total).toBe(1);
  });

  it('uses physical page positions, not printed labels', () => {
    const md = '<!-- page iv -->\nalpha\n<!-- page 7 -->\nbeta\n';
    expect(searchMarkdown(md, 'alpha').hits[0].page).toBe(1);
    expect(searchMarkdown(md, 'beta').hits[0].page).toBe(2);
  });

  it('omits page and section when the document has none', () => {
    const hit = searchMarkdown('just text\nneedle here\n', 'needle').hits[0];
    expect(hit.page).toBeUndefined();
    expect(hit.section).toBeUndefined();
  });

  it('includes context lines around a hit', () => {
    const out = searchMarkdown(DOC, 'costs will fall', { context: 1 });
    expect(out.hits[0].text.split('\n')).toEqual(['### Outlook', 'Costs will fall.', 'filler line 0']);
  });

  it('merges neighbouring hits into one window', () => {
    const out = searchMarkdown(DOC, 'revenue', { context: 2 });
    expect(out.total).toBe(1);
    expect(out.hits[0].line).toBe(5);
    expect(out.hits[0].text).toContain('Total revenue was');
  });

  it('truncates the list at maxHits and keeps the real total', () => {
    const md = Array.from({ length: 10 }, (_, i) => `hit ${i}\n\n\n\n\n\n\n`).join('');
    const out = searchMarkdown(md, 'hit', { context: 0, maxHits: 3 });
    expect(out.hits).toHaveLength(3);
    expect(out.total).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it('caps each hit text at 600 characters', () => {
    const md = `${'x'.repeat(2000)} needle\n`;
    const text = searchMarkdown(md, 'needle').hits[0].text;
    expect(text.length).toBe(600);
  });

  it('treats the query literally unless regex is set', () => {
    expect(searchMarkdown('a.c abc\n', 'a.c', { context: 0 }).total).toBe(1);
    expect(searchMarkdown('abc\n', 'a.c').total).toBe(0);
    expect(searchMarkdown('abc\n', 'a.c', { regex: true }).total).toBe(1);
  });

  it('matches regexes across wraps and respects case flags', () => {
    expect(searchMarkdown(DOC, 'revenue was \\d+,\\d+ \\d+', { regex: true }).total).toBe(1);
    expect(searchMarkdown('Foo\n', 'foo', { regex: true }).total).toBe(1);
    expect(searchMarkdown('Foo\n', 'foo', { regex: true, caseSensitive: true }).total).toBe(0);
  });

  it('rejects an over-long regex, an invalid regex and an empty query', () => {
    expect(() => searchMarkdown('x', 'a'.repeat(201), { regex: true })).toThrow(/too long/i);
    expect(() => searchMarkdown('x', '(', { regex: true })).toThrow(/invalid/i);
    expect(() => searchMarkdown('x', '   ')).toThrow(/empty/i);
  });

  it('survives regexes that match the empty string', () => {
    expect(searchMarkdown('abc\n', 'x*', { regex: true }).total).toBe(0);
  });
});

describe('renderHits', () => {
  it('prints p.<page> L<line>: text and indents continuation lines', () => {
    const out = renderHits([
      { line: 4, page: 1, text: 'one\ntwo' },
      { line: 9, text: 'three' },
    ]);
    expect(out).toBe('p.1 L4: one\n  two\nL9: three');
  });
});
