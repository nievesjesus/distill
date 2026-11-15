import { describe, expect, it } from 'vitest';
import { readCsv } from '../../../src/node/office/csv';

const enc = (s: string) => new TextEncoder().encode(s);

describe('readCsv', () => {
  it('handles quoted commas, escaped quotes and newlines', () => {
    const r = readCsv(enc('a,b\r\n"x, y","say ""hi""\nthere"\r\n'));
    expect(r.json).toEqual({ rows: [['a', 'b'], ['x, y', 'say "hi"\nthere']] });
    expect(r.markdown).toBe('| a | b |\n| --- | --- |\n| x, y | say "hi" there |');
    expect(r.pages).toBe(1);
  });

  it('detects semicolons', () => {
    const r = readCsv(enc('a;b;c\n1;2;3\n'));
    expect(r.json).toEqual({ rows: [['a', 'b', 'c'], ['1', '2', '3']] });
  });

  it('detects tabs and ignores delimiters inside quotes', () => {
    const r = readCsv(enc('"a,b,c"\td\n1\t2\n'));
    expect(r.json).toEqual({ rows: [['a,b,c', 'd'], ['1', '2']] });
  });

  it('strips a UTF-8 BOM', () => {
    const r = readCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a,b\n1,2')]));
    expect(r.json).toEqual({ rows: [['a', 'b'], ['1', '2']] });
  });

  it('returns empty markdown for an empty file', () => {
    expect(readCsv(new Uint8Array()).markdown).toBe('');
  });
});
