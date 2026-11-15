import { DistillError } from '../errors';
import { gfmTable, type OfficeResult } from './markdown';
import { attr, children, parseXml, textOf } from './xml';
import { readZip, zipText } from './zip';

const MAX_CELLS = 1_000_000;

interface Sheet {
  name: string;
  rows: string[][];
}

function findRoot(doc: unknown[], tag: string): unknown[] {
  for (const node of doc) {
    const found = children(node, tag);
    if (found.length > 0 || (node as Record<string, unknown>)[tag] !== undefined) return found;
  }
  return [];
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts: string[] = ['xl'];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function readSharedStrings(entries: Map<string, Uint8Array>): string[] {
  const text = zipText(entries, 'xl/sharedStrings.xml');
  if (text === null) return [];
  const out: string[] = [];
  for (const item of findRoot(parseXml(text), 'sst')) {
    const si = children(item, 'si');
    if (si.length === 0 && (item as Record<string, unknown>).si === undefined) continue;
    out.push(textOfStringItem(si));
  }
  return out;
}

function textOfStringItem(si: unknown[]): string {
  let out = '';
  for (const part of si) {
    if (children(part, 't').length > 0 || (part as Record<string, unknown>).t !== undefined) out += textOf(part);
    else if ((part as Record<string, unknown>).r !== undefined) {
      for (const run of children(part, 'r')) {
        if ((run as Record<string, unknown>).t !== undefined) out += textOf(run);
      }
    }
  }
  return out;
}

function cellValue(cell: unknown, shared: string[]): string {
  const type = attr(cell, 't');
  const content = children(cell, 'c');
  if (type === 'inlineStr') {
    for (const part of content) {
      if ((part as Record<string, unknown>).is !== undefined) return textOfStringItem(children(part, 'is'));
    }
    return '';
  }
  let raw = '';
  for (const part of content) {
    if ((part as Record<string, unknown>).v !== undefined) raw = textOf(children(part, 'v'));
  }
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw === '' ? '' : raw === '0' ? 'FALSE' : 'TRUE';
  return raw;
}

function readSheet(xml: string, shared: string[], budget: { left: number }): string[][] {
  const grid = new Map<number, Map<number, string>>();
  const sheetData = findRoot(parseXml(xml), 'worksheet').find(
    (node) => (node as Record<string, unknown>).sheetData !== undefined,
  );
  let nextRow = 0;
  for (const rowNode of children(sheetData, 'sheetData')) {
    if ((rowNode as Record<string, unknown>).row === undefined) continue;
    const rowAttr = attr(rowNode, 'r');
    const rowIndex = rowAttr !== undefined && Number(rowAttr) > 0 ? Number(rowAttr) - 1 : nextRow;
    nextRow = rowIndex + 1;
    let nextCol = 0;
    for (const cell of children(rowNode, 'row')) {
      if ((cell as Record<string, unknown>).c === undefined) continue;
      if (budget.left <= 0) return compact(grid);
      budget.left--;
      const ref = attr(cell, 'r');
      const colIndex = ref !== undefined ? columnIndex(ref) : nextCol;
      nextCol = colIndex + 1;
      const value = cellValue(cell, shared);
      if (value === '' || colIndex < 0) continue;
      let row = grid.get(rowIndex);
      if (!row) {
        row = new Map();
        grid.set(rowIndex, row);
      }
      row.set(colIndex, value);
    }
  }
  return compact(grid);
}

function compact(grid: Map<number, Map<number, string>>): string[][] {
  const rowKeys = [...grid.keys()].sort((a, b) => a - b);
  const colSet = new Set<number>();
  for (const row of grid.values()) for (const col of row.keys()) colSet.add(col);
  const colKeys = [...colSet].sort((a, b) => a - b);
  return rowKeys.map((r) => {
    const row = grid.get(r) as Map<number, string>;
    return colKeys.map((c) => row.get(c) ?? '');
  });
}

export function readXlsx(bytes: Uint8Array): OfficeResult {
  const entries = readZip(bytes);
  const workbookXml = zipText(entries, 'xl/workbook.xml');
  if (workbookXml === null) throw new DistillError('parse_failed', 'Workbook has no xl/workbook.xml');
  const relsXml = zipText(entries, 'xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (relsXml !== null) {
    for (const rel of findRoot(parseXml(relsXml), 'Relationships')) {
      const id = attr(rel, 'Id');
      const target = attr(rel, 'Target');
      if (id !== undefined && target !== undefined) targets.set(id, resolveTarget(target));
    }
  }
  const shared = readSharedStrings(entries);
  const budget = { left: MAX_CELLS };
  const sheets: Sheet[] = [];
  for (const node of findRoot(parseXml(workbookXml), 'workbook')) {
    if ((node as Record<string, unknown>).sheets === undefined) continue;
    for (const sheet of children(node, 'sheets')) {
      if ((sheet as Record<string, unknown>).sheet === undefined) continue;
      const state = attr(sheet, 'state');
      if (state === 'hidden' || state === 'veryHidden') continue;
      const name = attr(sheet, 'name') ?? '';
      const target = targets.get(attr(sheet, 'id') ?? '');
      const xml = target === undefined ? null : zipText(entries, target);
      sheets.push({ name, rows: xml === null ? [] : readSheet(xml, shared, budget) });
    }
  }
  const markdown = sheets
    .map((s) => `## ${s.name}\n\n${s.rows.length === 0 ? '_(empty)_' : gfmTable(s.rows)}`)
    .join('\n\n');
  return { markdown, pages: sheets.length, json: { sheets } };
}
