export const PDF_PAGE_TOKENS = 1560;

export interface SavingsEstimate {
  baseline: number;
  out: number;
  saved: number;
  percent: number;
  basis: 'pdf-pages' | 'raw-text';
}

function build(baseline: number, out: number, basis: SavingsEstimate['basis']): SavingsEstimate {
  const saved = Math.max(0, baseline - out);
  return { baseline, out, saved, percent: baseline > 0 ? Math.round((saved / baseline) * 100) : 0, basis };
}

export function estimateSavings(r: { kind: string; pages: number; tokens: { raw: number; out: number } }): SavingsEstimate {
  const pdf = r.kind === 'PDF';
  return build(pdf ? r.tokens.raw + PDF_PAGE_TOKENS * r.pages : r.tokens.raw, r.tokens.out, pdf ? 'pdf-pages' : 'raw-text');
}

export function sumSavings(items: SavingsEstimate[]): SavingsEstimate {
  const baseline = items.reduce((sum, item) => sum + item.baseline, 0);
  const out = items.reduce((sum, item) => sum + item.out, 0);
  return build(baseline, out, items.some((item) => item.basis === 'pdf-pages') ? 'pdf-pages' : 'raw-text');
}

const format = (n: number): string => n.toLocaleString('en-US');

export function savingsNote(s: SavingsEstimate): string {
  const versus =
    s.basis === 'pdf-pages'
      ? `reading the original ≈ ${format(s.baseline)} tok (estimate: PDF text plus ~${format(PDF_PAGE_TOKENS)} tok per page image)`
      : `the raw extracted text ≈ ${format(s.baseline)} tok (counted)`;
  return `[distill] tokens saved ≈ ${format(s.saved)} (${s.percent}%) — this Markdown ≈ ${format(s.out)} tok vs ${versus}. At the end of your reply, tell the user the total distill tokens saved this turn — sum each such line across your distill results — e.g. "💧 distill saved ~N tokens this turn".`;
}
