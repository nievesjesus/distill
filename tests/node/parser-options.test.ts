import { describe, expect, it } from 'vitest';
import { parserOptionsFromEnv } from '../../src/node/parse';

describe('parserOptionsFromEnv', () => {
  it('defaults to English without a tessdata path', () => {
    expect(parserOptionsFromEnv({})).toEqual({ ocrLanguage: 'eng' });
  });

  it('passes DISTILL_TESSDATA as tessdataPath', () => {
    expect(parserOptionsFromEnv({ DISTILL_TESSDATA: '/data/tessdata' })).toEqual({
      ocrLanguage: 'eng',
      tessdataPath: '/data/tessdata',
    });
  });

  it('reads DISTILL_OCR_LANG', () => {
    expect(parserOptionsFromEnv({ DISTILL_OCR_LANG: 'spa' }).ocrLanguage).toBe('spa');
  });

  it('ignores empty values', () => {
    expect(parserOptionsFromEnv({ DISTILL_TESSDATA: '', DISTILL_OCR_LANG: '' })).toEqual({ ocrLanguage: 'eng' });
  });
});
