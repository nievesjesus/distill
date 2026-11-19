const FENCE = /^\s*(```|~~~)/;

function splitLine(line: string, max: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const sentence = window.lastIndexOf('. ');
    const space = window.lastIndexOf(' ');
    if (sentence > 0 && sentence + 1 <= max) {
      parts.push(rest.slice(0, sentence + 1));
      rest = rest.slice(sentence + 2);
    } else if (space > 0 && space <= max) {
      parts.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
    } else {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  parts.push(rest);
  return parts;
}

export function wrapLongLines(markdown: string, max = 1500): string {
  let fenced = false;
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
    } else if (fenced || line.length <= max || line.trimStart().startsWith('|')) {
      out.push(line);
    } else {
      out.push(...splitLine(line, max));
    }
  }
  return out.join('\n');
}
