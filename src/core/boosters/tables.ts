import { mapProse } from './segments';

const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const UNESCAPED_PIPE = /(?<!\\)\|/;

function isPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

function splitCells(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  return inner.split(UNESCAPED_PIPE).map((cell) => cell.trim());
}

function compactSeparatorCell(cell: string): string {
  const left = cell.startsWith(':') ? ':' : '';
  const right = cell.endsWith(':') ? ':' : '';
  return `${left}-${right}`;
}

function compactRow(line: string, isSeparator: boolean): string {
  const cells = splitCells(line);
  return `|${(isSeparator ? cells.map(compactSeparatorCell) : cells).join('|')}|`;
}

function startsTable(lines: string[], index: number): boolean {
  return (
    isPipeRow(lines[index]) &&
    index + 1 < lines.length &&
    isPipeRow(lines[index + 1]) &&
    SEPARATOR.test(lines[index + 1].trim())
  );
}

function compactProse(prose: string): string {
  const lines = prose.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!startsTable(lines, i)) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && isPipeRow(lines[end])) end++;
    for (let row = i; row < end; row++) out.push(compactRow(lines[row], row === i + 1));
    i = end;
  }
  return out.join('\n');
}

export function compactTables(md: string): string {
  return mapProse(md, compactProse);
}
