import { slimProse } from './media';
import { mapProse } from './segments';

const MAX_LENGTH = 120;
const STRUCTURAL_START = /^(#|\||[-*+>]|\d+[.)])/;
const DEEP_INDENT = /^( {4}|\t)/;
const UNESCAPED_PIPE = /(?<!\\)\|/;
const PAGE_WORD = '(?:page|pg|p\\.|pág\\.?|pagina|página)';
const KEYWORD_WITH_TOTAL = `\\b${PAGE_WORD}\\s*\\d+\\s*(?:of|de|/)\\s*\\d+`;
const TOTAL_WITH_KEYWORD = '\\b\\d+\\s*(?:of|de)\\s*\\d+\\s*pages?';
const KEYWORD_INDICATOR = `(?:${KEYWORD_WITH_TOTAL}|${TOTAL_WITH_KEYWORD})`;
const SEPARATOR = '[\\s—–|·:-]';
const LEADING_INDICATOR = new RegExp(`^(${KEYWORD_INDICATOR})(?=${SEPARATOR}|$)`, 'i');
const TRAILING_INDICATOR = new RegExp(`(?<=^|${SEPARATOR})(${KEYWORD_INDICATOR})$`, 'i');
const WHOLE_LINE_INDICATORS: readonly RegExp[] = [
  new RegExp(`^${KEYWORD_INDICATOR}$`, 'i'),
  /^[-—–]\s*\d+\s*[-—–]$/,
];
const MIN_REPEAT_WORDS = 4;
const MIN_REPEAT_CHARS = 25;
const MIN_REPEATS = 3;

function maskDigits(indicator: string): string {
  return indicator.replace(/\d+/g, '#');
}

function isPageIndicatorLine(collapsed: string): boolean {
  return WHOLE_LINE_INDICATORS.some((pattern) => pattern.test(collapsed));
}

function isSubstantial(signature: string): boolean {
  return signature.length >= MIN_REPEAT_CHARS && signature.split(' ').length >= MIN_REPEAT_WORDS;
}

function signatureOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const collapsedWhole = trimmed.replace(/\s+/g, ' ');
  if (isPageIndicatorLine(collapsedWhole)) return maskDigits(collapsedWhole);
  if (STRUCTURAL_START.test(trimmed) || DEEP_INDENT.test(line) || UNESCAPED_PIPE.test(line)) return null;
  const collapsed = slimProse(trimmed).replace(/\s+/g, ' ').trim();
  const signature = collapsed
    .replace(LEADING_INDICATOR, maskDigits)
    .replace(TRAILING_INDICATOR, maskDigits);
  if (signature.length > MAX_LENGTH || !isSubstantial(signature)) return null;
  return signature;
}

export function dropRepeatedBoilerplate(md: string): string {
  const counts = new Map<string, number>();
  mapProse(md, (prose) => {
    for (const line of prose.split('\n')) {
      const signature = signatureOf(line);
      if (signature !== null) counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    return prose;
  });

  const seen = new Set<string>();
  return mapProse(md, (prose) =>
    prose
      .split('\n')
      .filter((line) => {
        const signature = signatureOf(line);
        if (signature === null || (counts.get(signature) ?? 0) < MIN_REPEATS) return true;
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      })
      .join('\n'),
  );
}
