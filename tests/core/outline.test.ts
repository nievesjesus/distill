import { describe, expect, it } from 'vitest';
import { buildOutline, fitLines, renderOutline, sliceLines } from '../../src/core/outline';
import { countTokens } from '../../src/core/tokens';

const heading = (md: string) => buildOutline(md);

describe('buildOutline heading mode', () => {
  const md = ['# Title', 'intro', '## A', 'a1', 'a2', '### A1', 'deep', '## B', 'b1'].join('\n');

  it('creates one entry per heading up to level 3 with nested end lines', () => {
    const o = heading(md);
    expect(o.lines).toBe(9);
    expect(o.tokens).toBe(countTokens(md));
    expect(o.entries.map((e) => [e.kind, e.level, e.title, e.line, e.endLine])).toEqual([
      ['heading', 1, '# Title', 1, 9],
      ['heading', 2, '## A', 3, 7],
      ['heading', 3, '### A1', 6, 7],
      ['heading', 2, '## B', 8, 9],
    ]);
  });

  it('counts tokens of the section lines', () => {
    const o = heading(md);
    expect(o.entries[1].tokens).toBe(countTokens(['## A', 'a1', 'a2', '### A1', 'deep'].join('\n')));
  });

  it('ignores headings of level 4 and deeper as entries', () => {
    const o = heading(['# A', 'x', '#### deep', 'y', '## B', 'z'].join('\n'));
    expect(o.entries.map((e) => e.title)).toEqual(['# A', '## B']);
    expect(o.entries[0].endLine).toBe(6);
  });

  it('ignores headings inside fenced code', () => {
    const o = heading(['# A', '```', '# not', '## nope', '```', '## B', '~~~', '# x', '~~~'].join('\n'));
    expect(o.entries.map((e) => e.title)).toEqual(['# A', '## B']);
  });

  it('prepends a start entry for text before the first heading', () => {
    const o = heading(['preface text', '', '# A', 'x', '## B', 'y'].join('\n'));
    expect(o.entries[0]).toMatchObject({ kind: 'start', level: 1, title: '(beginning)', line: 1, endLine: 2 });
    expect(o.entries[1]).toMatchObject({ kind: 'heading', line: 3 });
  });

  it('does not prepend a start entry when only blanks or page markers precede', () => {
    const o = heading(['<!-- page 1 -->', '', '# A', 'x', '## B', 'y'].join('\n'));
    expect(o.entries[0].kind).toBe('heading');
  });

  it('assigns the page label of the last marker before each heading', () => {
    const md = ['<!-- page 1 -->', '', '# A', 'x', '<!-- page iv -->', '', '## B', 'y'].join('\n');
    const o = heading(md);
    expect(o.entries.map((e) => e.page)).toEqual(['1', 'iv']);
  });

  it('has no page when there are no markers', () => {
    expect(heading(md).entries.every((e) => e.page === undefined)).toBe(true);
  });
});

describe('page titles without emphasis markers', () => {
  const titleOf = (first: string) => buildOutline(['<!-- page 1 -->', '', first, 'x', '<!-- page 2 -->', '', 'y'].join('\n')).entries[0].title;

  it('drops bold, italic and underscore emphasis but keeps snake_case and bullets', () => {
    expect(titleOf('**Bold** text')).toBe('Bold text');
    expect(titleOf('__Bold__ text')).toBe('Bold text');
    expect(titleOf('*Italic* and _more_ words')).toBe('Italic and more words');
    expect(titleOf('## **Chapter 1**')).toBe('Chapter 1');
    expect(titleOf('use my_var_name here')).toBe('use my_var_name here');
    expect(titleOf('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('buildOutline page mode', () => {
  const md = ['<!-- page 1 -->', '', '- Contract for services', 'text', '<!-- page 2 -->', '', '| Item | Qty |', 'row', '<!-- page 3 -->', '', 'last'].join('\n');

  it('uses one entry per page marker when headings are scarce', () => {
    const o = heading(md);
    expect(o.entries.map((e) => [e.kind, e.level, e.line, e.endLine, e.page])).toEqual([
      ['page', 1, 1, 4, '1'],
      ['page', 1, 5, 8, '2'],
      ['page', 1, 9, 11, '3'],
    ]);
  });

  it('titles pages with the first non-blank line stripped of markdown prefixes', () => {
    const o = heading(md);
    expect(o.entries[0].title).toBe('Contract for services');
    expect(o.entries[1].title).toBe('Item | Qty |');
  });

  it('truncates long titles to 60 characters with an ellipsis', () => {
    const long = 'x'.repeat(100);
    const o = heading(['<!-- page 1 -->', long, '<!-- page 2 -->', 'y'].join('\n'));
    expect(o.entries[0].title).toHaveLength(60);
    expect(o.entries[0].title.endsWith('…')).toBe(true);
  });

  it('prefers headings when there are two of level 3 or less', () => {
    const o = heading(['<!-- page 1 -->', '# A', 'x', '<!-- page 2 -->', '## B', 'y'].join('\n'));
    expect(o.entries.every((e) => e.kind === 'heading')).toBe(true);
  });

  it('prepends a start entry for text before the first marker', () => {
    const o = heading(['intro', '<!-- page 1 -->', 'a', '<!-- page 2 -->', 'b'].join('\n'));
    expect(o.entries[0]).toMatchObject({ kind: 'start', line: 1, endLine: 1 });
  });
});

describe('buildOutline fallback', () => {
  it('returns a single entry for plain text', () => {
    const o = heading(['> Just a note', 'more', 'lines'].join('\n'));
    expect(o.entries).toHaveLength(1);
    expect(o.entries[0]).toMatchObject({ kind: 'heading', level: 1, title: 'Just a note', line: 1, endLine: 3 });
  });

  it('uses a single heading as the fallback entry', () => {
    const o = heading(['# Only', 'text'].join('\n'));
    expect(o.entries).toHaveLength(1);
    expect(o.entries[0]).toMatchObject({ line: 1, endLine: 2 });
  });
});

describe('buildOutline maxEntries', () => {
  it('drops level 3 and then level 2 headings', () => {
    const parts: string[] = [];
    for (let i = 0; i < 3; i++) {
      parts.push(`# H${i}`, 'x');
      for (let j = 0; j < 3; j++) parts.push(`## S${i}${j}`, 'y', `### T${i}${j}`, 'z');
    }
    const md = parts.join('\n');
    const full = buildOutline(md);
    expect(full.entries).toHaveLength(3 + 9 + 9);
    const noL3 = buildOutline(md, { maxEntries: 20 });
    expect(noL3.entries).toHaveLength(12);
    expect(noL3.entries.every((e) => e.level <= 2)).toBe(true);
    const onlyL1 = buildOutline(md, { maxEntries: 5 });
    expect(onlyL1.entries).toHaveLength(3);
    expect(onlyL1.entries[0].endLine).toBe(onlyL1.entries[1].line - 1);
    expect(onlyL1.entries[0].tokens).toBeGreaterThan(noL3.entries[0].tokens - 1);
  });

  it('merges consecutive pages into groups', () => {
    const md = Array.from({ length: 10 }, (_, i) => `<!-- page ${i + 1} -->\n\nPage ${i + 1} body`).join('\n\n');
    const o = buildOutline(md, { maxEntries: 4 });
    expect(o.entries.map((e) => e.page)).toEqual(['1–3', '4–6', '7–9', '10']);
    expect(o.entries[0].title).toBe('Page 1 body');
    expect(o.entries[3].endLine).toBe(o.lines);
    expect(o.entries[0].endLine).toBe(o.entries[1].line - 1);
  });
});

describe('renderOutline', () => {
  it('renders the header and indented entries', () => {
    const md = ['<!-- page 1 -->', '', '# Title', 'intro', '## A', 'a1', '<!-- page 2 -->', '', '### A1', 'deep'].join('\n');
    const text = renderOutline(buildOutline(md), { name: 'doc.pdf' });
    const lines = text.split('\n');
    expect(lines[0]).toBe(`Index of doc.pdf: 10 lines, ~${countTokens(md).toLocaleString('en-US')} tokens (line numbers refer to this Markdown).`);
    expect(lines[1]).toMatch(/^L3-10 · \d+ tok · p\.1 · # Title$/);
    expect(lines[2]).toMatch(/^ {2}L5-10 · \d+ tok · p\.1 · ## A$/);
    expect(lines[3]).toMatch(/^ {4}L9-10 · \d+ tok · p\.2 · ### A1$/);
  });

  it('defaults the name and omits the page when absent', () => {
    const text = renderOutline(buildOutline('# A\nx\n## B\ny'));
    expect(text.split('\n')[0]).toMatch(/^Index of document: 4 lines, ~\d+ tokens/);
    expect(text.split('\n')[1]).not.toContain('p.');
  });

  it('formats large numbers with thousands separators', () => {
    const big = `# A\n${'word '.repeat(3000)}\n## B\nx`;
    expect(renderOutline(buildOutline(big))).toMatch(/~\d,\d{3} tokens/);
  });

  it('keeps line numbers plain while the header and token counts use separators', () => {
    const md = `# A\n${'line\n'.repeat(1500)}## B\nx`;
    const text = renderOutline(buildOutline(md));
    expect(text.split('\n')[0]).toMatch(/: 1,\d{3} lines, /);
    expect(text).toMatch(/L1-1503 /);
    expect(text).toMatch(/L1502-1503 /);
    expect(text).not.toMatch(/L[\d,]*\d,\d{3}/);
  });
});

describe('sliceLines', () => {
  const md = ['a', 'b', 'c', 'd', 'e'].join('\n');

  it('slices from a 1-based offset with an inclusive end', () => {
    expect(sliceLines(md, 2, 2)).toEqual({ text: 'b\nc', from: 2, to: 3, total: 5 });
  });

  it('reads to the end without a limit', () => {
    expect(sliceLines(md, 4)).toEqual({ text: 'd\ne', from: 4, to: 5, total: 5 });
  });

  it('clamps the end to the document', () => {
    expect(sliceLines(md, 5, 10)).toEqual({ text: 'e', from: 5, to: 5, total: 5 });
  });
});

describe('fitLines', () => {
  const md = Array.from({ length: 200 }, (_, i) => `Line number ${i} with some words`).join('\n');

  it('returns the largest line count within the token budget', () => {
    const n = fitLines(md, 100);
    const lines = md.split('\n');
    expect(countTokens(lines.slice(0, n).join('\n'))).toBeLessThanOrEqual(100);
    expect(countTokens(lines.slice(0, n + 1).join('\n'))).toBeGreaterThan(100);
  });

  it('returns at least one line', () => {
    expect(fitLines(md, 1)).toBe(1);
  });

  it('returns every line when everything fits', () => {
    expect(fitLines('a\nb', 1000)).toBe(2);
  });
});

describe('outline visual pages', () => {
  const FIG = '<!-- page 2: figure (chart or image not in this text; see the original page) -->';
  const SCAN = '<!-- page 3: scan (OCR text) -->';

  it('keeps the class on page entries and renders it', () => {
    const md = ['<!-- page 1 -->', '', 'one', FIG, '', 'two', SCAN, '', 'three'].join('\n');
    const o = buildOutline(md);
    expect(o.entries.map((e) => [e.page, e.visual])).toEqual([
      ['1', undefined],
      ['2', 'figure'],
      ['3', 'scan'],
    ]);
    const text = renderOutline(o);
    expect(text).toContain('p.2 · figure ·');
    expect(text).toContain('p.3 · scan ·');
  });

  it('lists visual pages inside a heading range', () => {
    const md = ['<!-- page 1 -->', '# A', 'x', FIG, 'y', SCAN, '# B', 'z'].join('\n');
    const o = buildOutline(md);
    expect(o.entries[0].visualPages).toEqual([{ page: '2', kind: 'figure' }]);
    expect(o.entries[1].visualPages).toEqual([{ page: '3', kind: 'scan' }]);
    const text = renderOutline(o);
    expect(text).toContain('figures p.2');
    expect(text).toContain('scans p.3');
    expect(text.split('\n')[2]).toContain('scans p.3');
  });

  it('keeps plain markers working', () => {
    const o = buildOutline(['<!-- page a:b -->', 'x', '<!-- page c -->', 'y'].join('\n'));
    expect(o.entries.map((e) => e.page)).toEqual(['a:b', 'c']);
  });
});
