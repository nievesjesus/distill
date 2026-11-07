import { describe, expect, it } from 'vitest';
import { dropRepeatedBoilerplate } from '@core/boosters/dedupe';

describe('dropRepeatedBoilerplate', () => {
  it('keeps the first occurrence of a long line repeated three or more times', () => {
    const footer = 'CONFIDENTIAL — Example Co. internal use only';
    expect(dropRepeatedBoilerplate(`X\n${footer}\nA\n${footer}\nB\n${footer}`)).toBe(`X\n${footer}\nA\nB`);
  });

  it('treats running headers differing only in the page indicator as the same', () => {
    const doc = [
      'Example Co. Annual Report — Page 1 of 3',
      'Alpha',
      'Example Co. Annual Report — Page 2 of 3',
      'Beta',
      'Example Co. Annual Report — Page 3 of 3',
      'Gamma',
    ].join('\n');
    expect(dropRepeatedBoilerplate(doc)).toBe('Example Co. Annual Report — Page 1 of 3\nAlpha\nBeta\nGamma');
  });

  it('keeps lines that appear fewer than three times', () => {
    const footer = 'CONFIDENTIAL — Example Co. internal use only';
    const doc = `${footer}\n${footer}\nB`;
    expect(dropRepeatedBoilerplate(doc)).toBe(doc);
  });

  it('never dedupes headings, list items or table rows', () => {
    expect(dropRepeatedBoilerplate('## H\n## H\n## H')).toBe('## H\n## H\n## H');
    expect(dropRepeatedBoilerplate('- a\n- a\n- a')).toBe('- a\n- a\n- a');
    expect(dropRepeatedBoilerplate('|a|\n|a|\n|a|')).toBe('|a|\n|a|\n|a|');
  });

  it('counts across prose segments but never touches fenced code', () => {
    const f = 'Footer text that repeats on every page';
    const md = `${f}\nx\n\`\`\`\n${f}\n\`\`\`\n${f}\ny\n${f}`;
    expect(dropRepeatedBoilerplate(md)).toBe(`${f}\nx\n\`\`\`\n${f}\n\`\`\`\ny`);
  });

  it('is lossless for lines differing in non-page digits', () => {
    const q = 'Q1 results strong\nQ2 results strong\nQ3 results strong';
    expect(dropRepeatedBoilerplate(q)).toBe(q);
  });

  it('never counts pipe rows, ordered items or indented code', () => {
    const table = 'Name | Value\n--- | ---\nA | 1\nA | 2\nA | 3';
    expect(dropRepeatedBoilerplate(table)).toBe(table);
    expect(dropRepeatedBoilerplate('1) item\n1) item\n1) item')).toBe('1) item\n1) item\n1) item');
    const code = '    code();\n    code();\n    code();';
    expect(dropRepeatedBoilerplate(code)).toBe(code);
  });

  it('dedupes whole-line page indicators in every supported form', () => {
    expect(dropRepeatedBoilerplate('p. 3/12\nA\np. 4/12\nB\np. 5/12\nC')).toBe('p. 3/12\nA\nB\nC');
    expect(dropRepeatedBoilerplate('3 of 12 pages\nA\n4 of 12 pages\nB\n5 of 12 pages\nC')).toBe('3 of 12 pages\nA\nB\nC');
    expect(dropRepeatedBoilerplate('Page 3 of 12\nA\nPage 4 of 12\nB\nPage 5 of 12\nC')).toBe('Page 3 of 12\nA\nB\nC');
    expect(dropRepeatedBoilerplate('Página 3 de 12\nA\nPágina 4 de 12\nB\nPágina 5 de 12\nC')).toBe('Página 3 de 12\nA\nB\nC');
    expect(dropRepeatedBoilerplate('- 3 -\nA\n- 4 -\nB\n- 5 -\nC')).toBe('- 3 -\nA\nB\nC');
  });

  it('keeps bare page references and whole-line bare fractions byte for byte', () => {
    const references = [
      'For details see the appendix table on page 12',
      'For details see the appendix table on page 15',
      'For details see the appendix table on page 20',
    ].join('\n');
    const quiz = 'Question one\n3/4\nQuestion two\n1/4\nQuestion three\n2/4\nQuestion four\n3/4\n1/4\n2/4\n3 / 4\n2 of 5\n2 of 5\n2 of 5';
    expect(dropRepeatedBoilerplate(references)).toBe(references);
    expect(dropRepeatedBoilerplate(quiz)).toBe(quiz);
    const bareThrice = '3/4\n3/4\n3/4\n2 of 5\n2 of 5\n2 of 5';
    expect(dropRepeatedBoilerplate(bareThrice)).toBe(bareThrice);
  });

  it('does not treat n/m inside a longer line as a page indicator', () => {
    const doc = 'Example Co. annual report — 3/14\nA\nExample Co. annual report — 4/14\nB\nExample Co. annual report — 5/14\nC';
    expect(dropRepeatedBoilerplate(doc)).toBe(doc);
  });

  it('keeps short repeated real content byte for byte', () => {
    const fixtures = [
      'Q: Is it covered?\nYes\nQ: Is it urgent?\nNo\nQ: Is it signed?\nYes\nQ: Is it paid?\nNo\nQ: Is it final?\nYes',
      'Item A\nN/A\nItem B\nN/A\nItem C\nN/A\nItem D\nApproved\nItem E\nApproved\nItem F\nApproved',
      'Subtotal\n$0.00\nTax\n$0.00\nShipping\n$0.00\nDiscount\n$0.00',
      'Score: 3/4\nScore: 1/4\nScore: 2/4\nScore: 4/4',
      'Score: 3/4\nScore: 3/4\nScore: 3/4\nScore: 3/4',
      'Na na na na\nHey hey hey\nNa na na na\nHey hey hey\nNa na na na\nHey hey hey',
      'Yes\nYes\nYes\nYes',
    ];
    for (const doc of fixtures) expect(dropRepeatedBoilerplate(doc)).toBe(doc);
  });

  it('requires four words and 25 characters to treat a line as boilerplate', () => {
    const threeWordsLong = 'Extraordinarily confidential documentation';
    const fourWordsShort = 'a b c d e f';
    const three = `${threeWordsLong}\n${threeWordsLong}\n${threeWordsLong}`;
    const short = `${fourWordsShort}\n${fourWordsShort}\n${fourWordsShort}`;
    expect(dropRepeatedBoilerplate(three)).toBe(three);
    expect(dropRepeatedBoilerplate(short)).toBe(short);
    const qualifying = 'Internal use only please do not distribute';
    expect(dropRepeatedBoilerplate(`${qualifying}\n${qualifying}\n${qualifying}`)).toBe(qualifying);
  });

  it('keeps lines that differ only inside link targets byte for byte', () => {
    const doc = [
      'Download the signed installer for this platform [here](https://example.com/mac)',
      'Download the signed installer for this platform [here](https://example.com/win)',
      'Download the signed installer for this platform [here](https://example.com/linux)',
    ].join('\n');
    expect(dropRepeatedBoilerplate(doc)).toBe(doc);
  });

  it('keeps long lines that carry a page cross-reference byte for byte', () => {
    const doc = [
      'For details see the appendix table on page 12 of 40',
      'For details see the appendix table on page 15 of 40',
      'For details see the appendix table on page 20 of 40',
    ].join('\n');
    expect(dropRepeatedBoilerplate(doc)).toBe(doc);
  });

  it('masks a trailing indicator only after a separator', () => {
    for (const separator of ['—', '|', '·']) {
      const lines = [3, 4, 5].map((n) => `Annual Report for Example Co. ${separator} Page ${n} of 12`);
      expect(dropRepeatedBoilerplate(lines.join('\nA\n'))).toBe(`${lines[0]}\nA\nA`);
    }
    const unseparated = [3, 4, 5].map((n) => `Annual Report for Example Co. Page ${n} of 12`).join('\n');
    expect(dropRepeatedBoilerplate(unseparated)).toBe(unseparated);
  });

  it('does not mask digits in dates or fractions', () => {
    for (const lines of [
      ['Updated 3/14/2026', 'Updated 4/2/2026', 'Updated 5/9/2026'],
      ['Add 1/2 cup flour', 'Add 3/4 cup flour', 'Add 1/3 cup flour'],
      ['Page 1 of 3 — Revenue 2024: $5M', 'Page 2 of 3 — Revenue 2023: $7M', 'Page 3 of 3 — Revenue 2022: $9M'],
    ]) {
      const doc = lines.join('\n');
      expect(dropRepeatedBoilerplate(doc)).toBe(doc);
    }
  });

  it('masks a page indicator at the start of the line', () => {
    const doc = 'Page 2 of 9 · Example Co.\nA\nPage 3 of 9 · Example Co.\nB\nPage 4 of 9 · Example Co.\nC';
    expect(dropRepeatedBoilerplate(doc)).toBe('Page 2 of 9 · Example Co.\nA\nB\nC');
  });

  it('applies the length limit to the line itself', () => {
    const long = `${'word '.repeat(30)}end`;
    const doc = [long, 'A', long, 'B', long].join('\n');
    expect(dropRepeatedBoilerplate(doc)).toBe(doc);
  });
});
