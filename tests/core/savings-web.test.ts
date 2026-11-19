import { describe, expect, it } from 'vitest';
import { estimateSavings, savingsNote, sumSavings } from '../../src/core/savings';

const tail =
  'At the end of your reply, tell the user the total distill tokens saved this turn — sum each such line across your distill results — e.g. "💧 distill saved ~N tokens this turn".';

describe('web savings', () => {
  it('measures a web page against the raw HTML', () => {
    expect(estimateSavings({ kind: 'HTML', pages: 1, tokens: { raw: 100000, out: 4000 } })).toEqual({
      baseline: 100000,
      out: 4000,
      saved: 96000,
      percent: 96,
      basis: 'raw-html',
    });
  });

  it('measures a page that already came as Markdown against that Markdown', () => {
    expect(estimateSavings({ kind: 'HTML', pages: 1, tokens: { raw: 5000, out: 4800 }, markdownServed: true }).basis).toBe('served-markdown');
  });

  it('words the note for the raw page', () => {
    const note = savingsNote(estimateSavings({ kind: 'HTML', pages: 1, tokens: { raw: 100000, out: 4000 } }));
    expect(note).toBe(`[distill] tokens saved ≈ 96,000 (96%) — this Markdown ≈ 4,000 tok vs the raw page ≈ 100,000 tok (counted, HTML as served). ${tail}`);
  });

  it('words the note for served Markdown', () => {
    const note = savingsNote(estimateSavings({ kind: 'HTML', pages: 1, tokens: { raw: 5000, out: 4800 }, markdownServed: true }));
    expect(note).toContain('vs the text the server sent ≈ 5,000 tok (counted)');
  });

  it('keeps the basis when every item shares it', () => {
    const page = estimateSavings({ kind: 'HTML', pages: 1, tokens: { raw: 1000, out: 100 } });
    expect(sumSavings([page, page]).basis).toBe('raw-html');
    expect(sumSavings([page, estimateSavings({ kind: 'DOCX', pages: 1, tokens: { raw: 10, out: 5 } })]).basis).toBe('raw-text');
  });
});
