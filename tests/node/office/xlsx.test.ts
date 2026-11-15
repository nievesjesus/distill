import { describe, expect, it } from 'vitest';
import { readXlsx } from '../../../src/node/office/xlsx';
import { makeXlsx } from '../../fixtures/office';

describe('readXlsx', () => {
  it('renders two sheets from shared strings', () => {
    const r = readXlsx(
      makeXlsx([
        { name: 'People', rows: [['Name', 'Age'], ['Ann', 30]] },
        { name: 'Pets', rows: [['Kind'], ['Cat']] },
      ]),
    );
    expect(r.markdown).toBe(
      '## People\n\n| Name | Age |\n| --- | --- |\n| Ann | 30 |\n\n## Pets\n\n| Kind |\n| --- |\n| Cat |',
    );
    expect(r.pages).toBe(2);
    expect(r.json).toEqual({
      sheets: [
        { name: 'People', rows: [['Name', 'Age'], ['Ann', '30']] },
        { name: 'Pets', rows: [['Kind'], ['Cat']] },
      ],
    });
  });

  it('reads inline strings', () => {
    const r = readXlsx(makeXlsx([{ name: 'S', rows: [['h'], ['v']] }], { sharedStrings: false }));
    expect(r.markdown).toBe('## S\n\n| h |\n| --- |\n| v |');
  });

  it('renders numbers and booleans', () => {
    const r = readXlsx(makeXlsx([{ name: 'S', rows: [['n', 'b'], [1.5, true], [2, false]] }]));
    expect(r.markdown).toBe('## S\n\n| n | b |\n| --- | --- |\n| 1.5 | TRUE |\n| 2 | FALSE |');
  });

  it('skips hidden sheets', () => {
    const r = readXlsx(
      makeXlsx([
        { name: 'Shown', rows: [['a']] },
        { name: 'Secret', rows: [['b']], hidden: true },
      ]),
    );
    expect(r.markdown).not.toContain('Secret');
    expect(r.pages).toBe(1);
  });

  it('escapes pipes in cells', () => {
    const r = readXlsx(makeXlsx([{ name: 'S', rows: [['A|B']] }]));
    expect(r.markdown).toContain('| A\\|B |');
  });

  it('handles a sparse sheet quickly with bounded size', () => {
    const rawRows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>' +
      '<row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>last</t></is></c></row>';
    const bytes = makeXlsx([{ name: 'Sparse', rows: [], rawRows }]);
    const start = Date.now();
    const r = readXlsx(bytes);
    expect(Date.now() - start).toBeLessThan(1000);
    expect((r.json as { sheets: { rows: string[][] }[] }).sheets[0].rows).toEqual([['first', ''], ['', 'last']]);
  });

  it('drops empty rows and columns and ignores empty values', () => {
    const rawRows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>' +
      '<row r="3"><c r="B3" t="inlineStr"><is><t>y</t></is></c><c r="C3"><v></v></c></row>';
    const r = readXlsx(makeXlsx([{ name: 'S', rows: [], rawRows }]));
    expect((r.json as { sheets: { rows: string[][] }[] }).sheets[0].rows).toEqual([['x', ''], ['', 'y']]);
  });

  it('marks an empty sheet', () => {
    const r = readXlsx(makeXlsx([{ name: 'Blank', rows: [] }]));
    expect(r.markdown).toBe('## Blank\n\n_(empty)_');
  });
});
