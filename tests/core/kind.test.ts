import { describe, expect, it } from 'vitest';
import { detectKind, needsLibreOfficeFor } from '@core/kind';

describe('detectKind', () => {
  it('detects by extension ignoring case', () => {
    expect(detectKind('Report.PDF')).toBe('PDF');
    expect(detectKind('a.docx')).toBe('DOCX');
    expect(detectKind('a.doc')).toBe('DOCX');
    expect(detectKind('a.PPTX')).toBe('PPTX');
    expect(detectKind('a.ppt')).toBe('PPTX');
    expect(detectKind('a.xlsx')).toBe('XLSX');
    expect(detectKind('a.xls')).toBe('XLSX');
    expect(detectKind('a.csv')).toBe('XLSX');
    expect(detectKind('a.odt')).toBe('ODF');
    expect(detectKind('a.ods')).toBe('ODF');
    expect(detectKind('a.odp')).toBe('ODF');
    for (const ext of ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp']) {
      expect(detectKind(`pic.${ext}`)).toBe('IMG');
    }
  });

  it('detects saved web pages, books, mail and feeds', () => {
    for (const name of ['a.html', 'a.HTM', 'a.xhtml', 'a.mhtml', 'a.MHT']) expect(detectKind(name)).toBe('HTML');
    expect(detectKind('a.epub')).toBe('EPUB');
    expect(detectKind('a.eml')).toBe('EMAIL');
    expect(detectKind('a.MSG')).toBe('EMAIL');
    for (const name of ['a.xml', 'a.rss', 'a.atom']) expect(detectKind(name)).toBe('FEED');
  });

  it('detects audio and video, with webm as video and aiff as audio', () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'MP3']) expect(detectKind(`a.${ext}`)).toBe('AUDIO');
    for (const ext of ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'MOV']) expect(detectKind(`a.${ext}`)).toBe('VIDEO');
  });

  it('returns null for unknown or missing extensions', () => {
    expect(detectKind('a.tar.gz')).toBeNull();
    expect(detectKind('noext')).toBeNull();
  });
});

describe('needsLibreOfficeFor', () => {
  it('is true only for legacy and OpenDocument office files', () => {
    for (const name of ['a.doc', 'a.xls', 'a.ppt', 'a.odt', 'a.ods', 'a.ODP']) expect(needsLibreOfficeFor(name)).toBe(true);
    for (const name of ['a.docx', 'a.xlsx', 'a.pptx', 'a.csv', 'a.pdf', 'a.png', 'noext']) expect(needsLibreOfficeFor(name)).toBe(false);
  });
});
