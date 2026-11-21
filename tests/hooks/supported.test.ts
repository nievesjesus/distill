import { describe, expect, it } from 'vitest';
import { isHookConvertible } from '../../src/hooks/supported';

describe('isHookConvertible', () => {
  it.each(['/a/x.pdf', '/a/x.DOCX', '/a/x.pptx', '/a/x.xlsx', '/a/x.odt', '/a/x.mhtml', '/a/x.MHT', '/a/x.epub', '/a/x.eml', '/a/x.msg', '/a/x.mp3', '/a/x.WAV', '/a/x.m4a', '/a/x.flac', '/a/x.opus', '/a/x.aiff', '/a/x.mp4', '/a/x.MOV', '/a/x.mkv', '/a/x.webm', '/a/x.avi', '/a/x.m4v'])('accepts %s', (path) => {
    expect(isHookConvertible(path)).toBe(true);
  });

  it.each(['/a/x.png', '/a/x.jpg', '/a/x.txt', '/a/x', '/a/x.md', '/a/x.csv', '/a/x.CSV', '/a/x.html', '/a/x.htm', '/a/x.xhtml', '/a/x.xml', '/a/x.rss', '/a/x.atom'])('rejects %s', (path) => {
    expect(isHookConvertible(path)).toBe(false);
  });
});
