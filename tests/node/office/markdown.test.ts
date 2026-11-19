import { describe, expect, it } from 'vitest';
import { escapeCell, escapeText, gfmTable } from '../../../src/node/office/markdown';

function splitRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      current += ch + row[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.slice(1, -1).map((c) => c.trim());
}

describe('escapeCell', () => {
  it('escapes pipes and collapses newlines', () => {
    expect(escapeCell(' a|b\nc ')).toBe('a\\|b c');
  });

  it('keeps a backslash-pipe sequence from splitting the cell', () => {
    expect(escapeCell('a\\|b')).toBe('a\\\\\\|b');
  });

  it('doubles a trailing backslash', () => {
    expect(escapeCell('abc\\')).toBe('abc\\\\');
  });

  it('produces the intended column count for a cell with backslash-pipe', () => {
    const table = gfmTable([
      ['h1', 'h2'],
      ['a\\|b', 'c'],
    ]);
    for (const row of table.split('\n')) expect(splitRow(row)).toHaveLength(2);
  });

  it('keeps the row width with a trailing backslash cell', () => {
    const table = gfmTable([
      ['h1', 'h2'],
      ['abc\\', 'c'],
    ]);
    for (const row of table.split('\n')) expect(splitRow(row)).toHaveLength(2);
  });
});

describe('escapeText', () => {
  it('escapes asterisks, underscores and a leading hash', () => {
    expect(escapeText('# a *b* _c_')).toBe('\\# a \\*b\\* \\_c\\_');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeText('plain text snake_case')).toBe('plain text snake_case');
  });

  it('keeps a literal backslash before an asterisk from cancelling the escape', () => {
    expect(escapeText('\\*bold*')).toBe('\\\\\\*bold\\*');
  });

  it('doubles literal backslashes', () => {
    expect(escapeText('a\\b')).toBe('a\\\\b');
  });
});
