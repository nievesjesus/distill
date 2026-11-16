import { describe, expect, it } from 'vitest';
import { PDF_PAGE_TOKENS, estimateSavings, savingsNote, sumSavings } from '../../src/core/savings';

describe('estimateSavings', () => {
  it('adds the page image cost to a PDF baseline', () => {
    expect(PDF_PAGE_TOKENS).toBe(1560);
    expect(estimateSavings({ kind: 'PDF', pages: 7, tokens: { raw: 1813, out: 1731 } })).toEqual({
      baseline: 12733,
      out: 1731,
      saved: 11002,
      percent: 86,
      basis: 'pdf-pages',
    });
  });

  it('uses the raw text for Office files', () => {
    expect(estimateSavings({ kind: 'DOCX', pages: 4, tokens: { raw: 1000, out: 600 } })).toEqual({
      baseline: 1000,
      out: 600,
      saved: 400,
      percent: 40,
      basis: 'raw-text',
    });
  });

  it('never reports negative savings and handles a zero baseline', () => {
    expect(estimateSavings({ kind: 'DOCX', pages: 1, tokens: { raw: 10, out: 20 } }).saved).toBe(0);
    expect(estimateSavings({ kind: 'DOCX', pages: 0, tokens: { raw: 0, out: 0 } })).toEqual({
      baseline: 0,
      out: 0,
      saved: 0,
      percent: 0,
      basis: 'raw-text',
    });
  });
});

describe('sumSavings', () => {
  it('adds up estimates and recomputes the percent', () => {
    const pdf = estimateSavings({ kind: 'PDF', pages: 7, tokens: { raw: 1813, out: 1731 } });
    const docx = estimateSavings({ kind: 'DOCX', pages: 1, tokens: { raw: 1000, out: 600 } });
    expect(sumSavings([pdf, docx])).toEqual({ baseline: 13733, out: 2331, saved: 11402, percent: 83, basis: 'pdf-pages' });
    expect(sumSavings([docx]).basis).toBe('raw-text');
    expect(sumSavings([])).toEqual({ baseline: 0, out: 0, saved: 0, percent: 0, basis: 'raw-text' });
  });
});

describe('savingsNote', () => {
  const tail =
    'At the end of your reply, tell the user the total distill tokens saved this turn — sum each such line across your distill results — e.g. "💧 distill saved ~N tokens this turn".';

  it('describes the PDF estimate with thousands separators', () => {
    const note = savingsNote(estimateSavings({ kind: 'PDF', pages: 7, tokens: { raw: 1813, out: 1731 } }));
    expect(note).toBe(
      `[distill] tokens saved ≈ 11,002 (86%) — this Markdown ≈ 1,731 tok vs reading the original ≈ 12,733 tok (estimate: PDF text plus ~1,560 tok per page image). ${tail}`,
    );
  });

  it('describes the counted raw text baseline', () => {
    const note = savingsNote(estimateSavings({ kind: 'XLSX', pages: 1, tokens: { raw: 2000, out: 500 } }));
    expect(note).toBe(
      `[distill] tokens saved ≈ 1,500 (75%) — this Markdown ≈ 500 tok vs the raw extracted text ≈ 2,000 tok (counted). ${tail}`,
    );
  });
});
