import { slimProse } from './media';
import { mapProse } from './segments';

const MAX_LENGTH = 120;
const STRUCTURAL_START = /^(#|\||[-*+>]|\d+[.)])/;
const DEEP_INDENT = /^( {4}|\t)/;
const UNESCAPED_PIPE = /(?<!\\)\|/;
const INDICATOR =
  '(?:\\b(?:page|pg|p\\.|pág\\.?|pagina|página)\\s*\\d+(?:\\s*(?:of|de|/)\\s*\\d+)?|(?<![\\d/])\\d+\\s*(?:of|de|/)\\s*\\d+(?!/\\d))';
const SEPARATOR = '[\\s—–|·:-]';
const LEADING_INDICATOR = new RegExp(`^(${INDICATOR})(?=${SEPARATOR}|$)`, 'i');
const TRAILING_INDICATOR = new RegExp(`(?<=^|${SEPARATOR})(${INDICATOR})$`, 'i');
const MIN_REPEATS = 3;

function maskDigits(indicator: string): string {
  return indicator.replace(/\d+/g, '#');
}

function signatureOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  if (STRUCTURAL_START.test(trimmed) || DEEP_INDENT.test(line) || UNESCAPED_PIPE.test(line)) return null;
  const collapsed = slimProse(trimmed).replace(/\s+/g, ' ').trim();
  const signature = collapsed
    .replace(LEADING_INDICATOR, maskDigits)
    .replace(TRAILING_INDICATOR, maskDigits);
  return signature.length > MAX_LENGTH ? null : signature;
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
