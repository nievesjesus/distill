export interface OfficeResult {
  markdown: string;
  pages: number;
  json: unknown;
}

export function escapeCell(text: string): string {
  return text.replace(/[\\|]/g, '\\$&').replace(/\r\n|\r|\n/g, ' ').trim();
}

export function gfmTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]): string => {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push(escapeCell(row[i] ?? ''));
    return `| ${cells.join(' | ')} |`;
  };
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join('\n');
}

export function escapeText(text: string): string {
  return text
    .replace(/[\\*]/g, '\\$&')
    .replace(/^(\s*)#/, '$1\\#')
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace('_', '\\_'));
}
