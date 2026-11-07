import { describe, expect, it } from 'vitest';
import { isHookConvertible } from '../../src/hooks/supported';

describe('isHookConvertible', () => {
  it.each(['/a/x.pdf', '/a/x.DOCX', '/a/x.pptx', '/a/x.xlsx', '/a/x.odt'])('accepts %s', (path) => {
    expect(isHookConvertible(path)).toBe(true);
  });

  it.each(['/a/x.png', '/a/x.jpg', '/a/x.txt', '/a/x', '/a/x.md', '/a/x.csv', '/a/x.CSV'])('rejects %s', (path) => {
    expect(isHookConvertible(path)).toBe(false);
  });
});
