import { describe, expect, it } from 'vitest';
import { mdName, uniqueNames, zipEntryName } from '../src/lib/names';

describe('mdName', () => {
  it('keeps unicode and emoji', () => {
    expect(mdName('Informe Año 2025 📊.pdf')).toBe('Informe Año 2025 📊.md');
  });

  it('appends .md when there is no extension', () => {
    expect(mdName('noext')).toBe('noext.md');
  });

  it('handles hidden files, multiple dots and trailing dots', () => {
    expect(mdName('.hidden')).toBe('.hidden.md');
    expect(mdName('a.b.c.pdf')).toBe('a.b.c.md');
    expect(mdName('x.')).toBe('x.md');
  });

  it('strips path separators', () => {
    expect(mdName('folder/sub\\report.pdf')).toBe('report.md');
    expect(mdName('../../etc/passwd')).toBe('passwd.md');
  });
});

describe('uniqueNames', () => {
  it('numbers repeated names', () => {
    expect(uniqueNames(['a.md', 'a.md', 'a.md'])).toEqual(['a.md', 'a (2).md', 'a (3).md']);
  });

  it('collides case-insensitively', () => {
    expect(uniqueNames(['A.md', 'a.md'])).toEqual(['A.md', 'a (2).md']);
  });

  it('does not reuse a number already taken', () => {
    expect(uniqueNames(['a.md', 'a (2).md', 'a.md'])).toEqual(['a.md', 'a (2).md', 'a (3).md']);
  });
});

describe('zipEntryName', () => {
  it('replaces characters Windows forbids', () => {
    expect(zipEntryName('a<b>c:d"e|f?g*h.md')).toBe('a_b_c_d_e_f_g_h.md');
    expect(zipEntryName('x\u0001y.md')).toBe('x_y.md');
  });

  it('trims trailing dots and spaces from the stem', () => {
    expect(zipEntryName('report. . .md')).toBe('report.md');
    expect(zipEntryName('..md')).toBe('document.md');
  });

  it('avoids reserved device names', () => {
    for (const reserved of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(zipEntryName(`${reserved}.md`)).toBe(`_${reserved}.md`);
    }
    expect(zipEntryName('CONSOLE.md')).toBe('CONSOLE.md');
    expect(zipEntryName('COM10.md')).toBe('COM10.md');
  });

  it('keeps unicode and ordinary names', () => {
    expect(zipEntryName('Informe Año 2025 📊.md')).toBe('Informe Año 2025 📊.md');
  });

  it('makes names that collapse to the same text unique', () => {
    expect(uniqueNames(['a:b.md', 'a?b.md'].map(zipEntryName))).toEqual(['a_b.md', 'a_b (2).md']);
  });
});
