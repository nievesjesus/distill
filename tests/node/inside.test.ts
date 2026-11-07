import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside } from '../../src/node/inside';

describe('isInside', () => {
  it('accepts the root itself and descendants', () => {
    expect(isInside('/a/b', '/a/b', posix)).toBe(true);
    expect(isInside('/a/b/c.pdf', '/a/b', posix)).toBe(true);
    expect(isInside('/a/b/c.pdf', '/a/b/', posix)).toBe(true);
  });

  it('rejects siblings that share a prefix', () => {
    expect(isInside('/a/b-evil/c.pdf', '/a/b', posix)).toBe(false);
    expect(isInside('C:\\work\\proj-evil\\c.pdf', 'C:\\work\\proj', win32)).toBe(false);
  });

  it('is case sensitive on posix', () => {
    expect(isInside('/A/b/c.pdf', '/a/b', posix)).toBe(false);
  });

  it('ignores case on windows', () => {
    expect(isInside('C:\\Users\\RunnerAdmin\\Temp\\a.pdf', 'c:\\users\\runneradmin\\temp', win32)).toBe(true);
    expect(isInside('C:\\Users\\RunnerAdmin', 'c:\\users\\runneradmin', win32)).toBe(true);
    expect(isInside('D:\\Users\\RunnerAdmin\\a.pdf', 'C:\\Users\\RunnerAdmin', win32)).toBe(false);
  });
});
