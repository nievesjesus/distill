import { slimProse } from './media';
import { mapProse } from './segments';

const MAX_LENGTH = 120;
const STRUCTURAL_START = /^(#|\||[-*+>]|\d+[.)])/;
const DEEP_INDENT = /^( {4}|\t)/;
const UNESCAPED_PIPE = /(?<!\\)\|/;
const PAGE_INDICATOR = /\b(page|pg|p\.|pág\.?|pagina|página)\s*\d+|\b\d+\s*(of|de|\/)\s*\d+\b/i;
const MIN_REPEATS = 3;

function signatureOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.length > MAX_LENGTH) return null;
  if (STRUCTURAL_START.test(trimmed) || DEEP_INDENT.test(line) || UNESCAPED_PIPE.test(line)) return null;
  const slim = slimProse(trimmed);
  const comparable = PAGE_INDICATOR.test(slim) ? slim.replace(/\d+/g, '#') : slim;
  return comparable.replace(/\s+/g, ' ').trim();
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
