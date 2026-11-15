import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../../src/node/office/html-to-markdown';

describe('htmlToMarkdown', () => {
  it('converts headings and paragraphs', () => {
    expect(htmlToMarkdown('<h1>Title</h1><h3>Sub</h3><p>Body text</p>')).toBe('# Title\n\n### Sub\n\nBody text');
  });

  it('converts bold and italic', () => {
    expect(htmlToMarkdown('<p><strong>a</strong> <b>b</b> <em>c</em> <i>d</i></p>')).toBe('**a** **b** *c* *d*');
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<p><a href="https://x.test/a">site</a></p>')).toBe('[site](https://x.test/a)');
  });

  it('converts nested lists', () => {
    const html = '<ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><ol><li>first</li><li>second</li></ol>';
    expect(htmlToMarkdown(html)).toBe('- one\n  - inner\n- two\n\n1. first\n1. second');
  });

  it('converts tables with the first row as header and escapes pipes', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>x|y</td><td>2</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| A | B |\n| --- | --- |\n| x\\|y | 2 |');
  });

  it('converts br, img, sup and unknown tags', () => {
    expect(htmlToMarkdown('<p>a<br />b</p>')).toBe('a\nb');
    expect(htmlToMarkdown('<p><img alt="logo" src="" /></p>')).toBe('![logo]()');
    expect(htmlToMarkdown('<p>x<sup>2</sup><sub>i</sub></p>')).toBe('x2i');
    expect(htmlToMarkdown('<p><span>kept</span></p>')).toBe('kept');
  });

  it('decodes entities', () => {
    expect(htmlToMarkdown('<p>&amp; &lt; &gt; &quot; &#39; &#65; &#x42;</p>')).toBe('& < > " \' A B');
  });

  it('escapes markdown characters in text', () => {
    expect(htmlToMarkdown('<p>2 * 3 and snake_case</p>')).toBe('2 \\* 3 and snake_case');
    expect(htmlToMarkdown('<p># not heading</p>')).toBe('\\# not heading');
    expect(htmlToMarkdown('<p>_lead_</p>')).toBe('\\_lead\\_');
  });

  it('collapses blank lines', () => {
    expect(htmlToMarkdown('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });
});
