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
