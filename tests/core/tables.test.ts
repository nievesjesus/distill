import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactTables } from '@core/boosters/tables';

const mixed = readFileSync(new URL('../fixtures/mixed.md', import.meta.url), 'utf8');

describe('compactTables', () => {
  it('trims cells and shortens the separator row', () => {
    expect(
      compactTables('| Metric        | 2024   |\n|---------------|:------:|\n| Revenue       | $12.4M |'),
    ).toBe('|Metric|2024|\n|-|:-:|\n|Revenue|$12.4M|');
  });

  it('maps every alignment marker', () => {
    expect(compactTables('|a|b|c|d|\n|:---|---:|:---:|---|')).toBe('|a|b|c|d|\n|:-|-:|:-:|-|');
  });

  it('ignores lines that are not tables', () => {
    expect(compactTables('not | a table')).toBe('not | a table');
  });

  it('keeps an already compact table', () => {
    expect(compactTables('|a|b|\n|-|-|')).toBe('|a|b|\n|-|-|');
  });

  it('ignores pipe rows without a separator line', () => {
    const md = '| a   | b   |\n| c   | d   |';
    expect(compactTables(md)).toBe(md);
  });

  it('keeps escaped pipes inside a cell', () => {
    expect(compactTables('| a \\| b | c |\n|---|---|\n| 1 | 2 |')).toBe('|a \\| b|c|\n|-|-|\n|1|2|');
  });

  it('keeps the indentation of a table inside a list item', () => {
    expect(compactTables('- item\n\n  | a   | b   |\n  |-----|-----|\n  | 1   | 2   |\n- next')).toBe(
      '- item\n\n  |a|b|\n  |-|-|\n  |1|2|\n- next',
    );
  });

  it('keeps the indentation of pipe rows in an indented code block', () => {
    const out = compactTables('para\n\n    | a | b |\n    |---|---|');
    expect(out.split('\n').slice(2).every((line) => line.startsWith('    |'))).toBe(true);
  });

  it('does not touch a table inside a fence', () => {
    const md = '```\n| a   | b   |\n|-----|-----|\n```';
    expect(compactTables(md)).toBe(md);
  });

  it('is idempotent over the mixed fixture', () => {
    const once = compactTables(mixed);
    expect(compactTables(once)).toBe(once);
    expect(once).toContain('|Metric|2024|2023|\n|-|:-:|-|');
    expect(once).toContain('| a   | b   |\n|-----|-----|');
  });
});
