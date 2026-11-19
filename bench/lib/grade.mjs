const WORDS = new Map(
  [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  ].map((word, index) => [word, index]),
);

const SCALES = new Map([
  ['k', 1e3],
  ['thousand', 1e3],
  ['m', 1e6],
  ['mm', 1e6],
  ['million', 1e6],
  ['b', 1e9],
  ['bn', 1e9],
  ['billion', 1e9],
  ['t', 1e12],
  ['trillion', 1e12],
]);

export function extractAnswer(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^[\s>*_`#-]*ANSWER[\s*_`]*:[\s*_`]*(.*)$/i.exec(lines[i]);
    if (match) {
      const value = match[1].replace(/[\s*_`]+$/, '').trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

export function parseNumbers(text) {
  const values = [];
  const pattern = /(-|−)?\s?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|[a-zA-Z]+)?/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const digits = match[2].replace(/,/g, '') + (match[3] ?? '');
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    if (match[1]) value = -value;
    values.push(value);
    const scale = match[4] ? SCALES.get(match[4].toLowerCase()) : undefined;
    if (scale !== undefined) values.push(value * scale);
  }
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (WORDS.has(word)) values.push(WORDS.get(word));
  }
  return values;
}

export function normalizeText(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function gradeAnswer(answer, expected) {
  if (answer === null || answer === undefined || answer === '') return null;
  if (expected.type === 'number') {
    const tolerance = expected.tolerance ?? 0;
    const slack = Math.max(tolerance, Math.abs(expected.value) * 1e-9);
    return parseNumbers(answer).some((value) => Math.abs(value - expected.value) <= slack);
  }
  const haystack = normalizeText(answer);
  const accepted = expected.type === 'oneOf' ? expected.value : [expected.value];
  return accepted.some((value) => haystack.includes(normalizeText(value)));
}

export function gradeReply(text, expected) {
  const answer = extractAnswer(text);
  return { answer, correct: gradeAnswer(answer, expected) };
}
