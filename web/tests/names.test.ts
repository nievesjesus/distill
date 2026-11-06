import { describe, expect, it } from 'vitest';
import { mdName, uniqueNames } from '../src/lib/names';

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
