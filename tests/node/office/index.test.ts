import { describe, expect, it, vi } from 'vitest';
import { builtinOfficeType, withBuiltinOffice } from '../../../src/node/office';
import type { Parser } from '../../../src/node/parse';
import { makeXlsx } from '../../fixtures/office';

function fakeParser(): Parser {
  return {
    toMarkdown: vi.fn(async () => ({ markdown: 'fake', pages: 1 })),
    toJson: vi.fn(async () => ({ fake: true })),
    close: vi.fn(),
  };
}

const xlsx = makeXlsx([{ name: 'S', rows: [['a', 'b'], [1, 2]] }]);
const readFile = async (): Promise<Uint8Array> => xlsx;

describe('builtinOfficeType', () => {
  it('maps extensions case-insensitively', () => {
    expect(builtinOfficeType('a.DOCX')).toBe('docx');
    expect(builtinOfficeType('/x/a.xlsx')).toBe('xlsx');
    expect(builtinOfficeType('a.pptx')).toBe('pptx');
    expect(builtinOfficeType('a.csv')).toBe('csv');
    expect(builtinOfficeType('a.doc')).toBeNull();
    expect(builtinOfficeType('a.pdf')).toBeNull();
    expect(builtinOfficeType('noext')).toBeNull();
  });
});

describe('withBuiltinOffice', () => {
  it('uses the reader without LibreOffice', async () => {
    const fake = fakeParser();
    const parser = withBuiltinOffice(fake, { libreoffice: false, readFile });
    const result = await parser.toMarkdown('/x/a.xlsx');
    expect(result.engine).toBe('builtin');
    expect(result.markdown).toContain('| a | b |');
    expect(fake.toMarkdown).not.toHaveBeenCalled();
    expect(await parser.toJson('/x/a.xlsx')).toHaveProperty('sheets');
    expect(fake.toJson).not.toHaveBeenCalled();
  });

  it('keeps the LiteParse path when LibreOffice is available', async () => {
    const fake = fakeParser();
    const parser = withBuiltinOffice(fake, { libreoffice: true, readFile });
    expect(await parser.toMarkdown('/x/a.xlsx')).toEqual({ markdown: 'fake', pages: 1, engine: 'liteparse' });
    expect(await parser.toJson('/x/a.xlsx')).toEqual({ fake: true });
    expect(fake.toMarkdown).toHaveBeenCalledWith('/x/a.xlsx');
  });

  it('sends pdf to the parser and delegates close', async () => {
    const fake = fakeParser();
    const parser = withBuiltinOffice(fake, { libreoffice: false, readFile });
    expect((await parser.toMarkdown('/x/a.pdf')).engine).toBe('liteparse');
    expect(fake.toMarkdown).toHaveBeenCalled();
    parser.close();
    expect(fake.close).toHaveBeenCalled();
  });
});
