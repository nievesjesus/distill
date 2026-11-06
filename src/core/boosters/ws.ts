import { mapProse } from './segments';

function squeezeLine(line: string): string {
  if (line.trim() === '') return '';
  const indent = /^\s*/.exec(line)![0];
  const body = line.slice(indent.length).replace(/\s+$/, '').replace(/ {2,}/g, ' ');
  return indent + body;
}

function collapseProse(prose: string): string {
  const out: string[] = [];
  for (const line of prose.split('\n').map(squeezeLine)) {
    const repeatsBlank = line === '' && out.length > 0 && out[out.length - 1] === '';
    if (!repeatsBlank) out.push(line);
  }
  return out.join('\n');
}

export function collapseWhitespace(md: string): string {
  return mapProse(md, collapseProse);
}
