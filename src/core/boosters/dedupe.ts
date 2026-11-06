import { mapProse } from './segments';

const MAX_LENGTH = 120;
const STRUCTURAL_START = /^(#|\||[-*+>]|\d+\.)/;
const MIN_REPEATS = 3;

function signatureOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.length > MAX_LENGTH || STRUCTURAL_START.test(trimmed)) return null;
  return trimmed.replace(/\d+/g, '#').replace(/\s+/g, ' ');
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
