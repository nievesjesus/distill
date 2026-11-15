import { posix } from 'node:path';
import { DistillError } from '../errors';
import { gfmTable, type OfficeResult } from './markdown';
import { attr, children, parseXml, textOf } from './xml';
import { readZip, zipText } from './zip';

interface Slide {
  title: string;
  paragraphs: string[];
  notes: string;
}

interface Block {
  text: string;
  markdown: string;
}

const SKIPPED_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr']);

function tagOf(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
  return Object.keys(node).find((key) => key !== ':@');
}

function has(node: unknown, tag: string): boolean {
  return tagOf(node) === tag;
}

function findRoot(doc: unknown[], tag: string): unknown[] {
  for (const node of doc) if (has(node, tag)) return children(node, tag);
  return [];
}

function descendants(node: unknown, tag: string): unknown[] {
  const out: unknown[] = [];
  const key = tagOf(node);
  if (key === undefined) return out;
  if (key === tag) out.push(node);
  for (const child of children(node, key)) out.push(...descendants(child, tag));
  return out;
}

function resolveTarget(baseDir: string, target: string): string {
  return target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(baseDir, target));
}

function readRels(entries: Map<string, Uint8Array>, partPath: string): { type: string; target: string; id: string }[] {
  const dir = posix.dirname(partPath);
  const xml = zipText(entries, `${dir}/_rels/${posix.basename(partPath)}.rels`);
  if (xml === null) return [];
  const out: { type: string; target: string; id: string }[] = [];
  for (const rel of findRoot(parseXml(xml), 'Relationships')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id === undefined || target === undefined) continue;
    out.push({ id, type: attr(rel, 'Type') ?? '', target: resolveTarget(dir, target) });
  }
  return out;
}

function escapeText(text: string): string {
  return text
    .replace(/^(\s*)#/, '$1\\#')
    .replace(/\*/g, '\\*')
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace('_', '\\_'));
}

function placeholderType(shape: unknown): string | undefined {
  const ph = descendants(shape, 'ph')[0];
  if (ph === undefined) return undefined;
  return attr(ph, 'type') ?? '';
}

function paragraphsOf(shape: unknown): { text: string; level: number; bullet: boolean }[] {
  const out: { text: string; level: number; bullet: boolean }[] = [];
  for (const body of descendants(shape, 'txBody')) {
    for (const p of children(body, 'txBody')) {
      if (!has(p, 'p')) continue;
      const content = children(p, 'p');
      const pPr = content.find((node) => has(node, 'pPr'));
      const lvl = Number(attr(pPr, 'lvl') ?? 0);
      const level = Number.isFinite(lvl) && lvl > 0 ? lvl : 0;
      const bullet = children(pPr, 'pPr').some((node) => has(node, 'buChar') || has(node, 'buAutoNum'));
      const text = textOf(content.filter((node) => !has(node, 'pPr'))).trim();
      if (text !== '') out.push({ text, level, bullet });
    }
  }
  return out;
}

function tableBlock(tbl: unknown): Block {
  const rows: string[][] = [];
  for (const tr of children(tbl, 'tbl')) {
    if (!has(tr, 'tr')) continue;
    const row: string[] = [];
    for (const tc of children(tr, 'tr')) {
      if (has(tc, 'tc')) row.push(descendants(tc, 'p').map((p) => textOf(p)).join(' ').trim());
    }
    rows.push(row);
  }
  const markdown = gfmTable(rows);
  return { text: markdown, markdown };
}

function collect(nodes: unknown[], blocks: Block[], titles: string[]): void {
  for (const node of nodes) {
    const key = tagOf(node);
    if (key === 'grpSp') collect(children(node, key), blocks, titles);
    else if (key === 'graphicFrame') {
      for (const tbl of descendants(node, 'tbl')) blocks.push(tableBlock(tbl));
    } else if (key === 'sp') {
      const type = placeholderType(node);
      const paras = paragraphsOf(node);
      if (type === 'title' || type === 'ctrTitle') {
        if (paras.length > 0) titles.push(paras.map((p) => p.text).join(' '));
        continue;
      }
      if (type !== undefined && SKIPPED_PLACEHOLDERS.has(type)) continue;
      for (const p of paras) {
        const indent = '  '.repeat(p.level);
        const escaped = escapeText(p.text);
        blocks.push({ text: p.text, markdown: p.bullet || p.level > 0 ? `${indent}- ${escaped}` : escaped });
      }
    }
  }
}

function shapeTree(xml: string, root: string): unknown[] {
  for (const node of findRoot(parseXml(xml), root)) {
    if (!has(node, 'cSld')) continue;
    for (const tree of children(node, 'cSld')) if (has(tree, 'spTree')) return children(tree, 'spTree');
  }
  return [];
}

function readNotes(xml: string): string {
  const out: string[] = [];
  for (const node of shapeTree(xml, 'notes')) {
    if (tagOf(node) === 'sp' && placeholderType(node) === 'body') out.push(...paragraphsOf(node).map((p) => p.text));
  }
  return out.join(' ');
}

function renderSlide(slide: Slide, blocks: Block[], n: number): string {
  const heading = slide.title === '' ? `## Slide ${n}` : `## Slide ${n}: ${slide.title}`;
  const parts = [heading];
  if (blocks.length > 0) parts.push(blocks.map((b) => b.markdown).join('\n'));
  if (slide.notes !== '') parts.push(`> Notes: ${slide.notes}`);
  return parts.join('\n\n');
}

export function readPptx(bytes: Uint8Array): OfficeResult {
  const entries = readZip(bytes);
  const presentation = zipText(entries, 'ppt/presentation.xml');
  if (presentation === null) throw new DistillError('parse_failed', 'Presentation has no ppt/presentation.xml');
  const targets = new Map(readRels(entries, 'ppt/presentation.xml').map((rel) => [rel.id, rel.target]));
  const slides: Slide[] = [];
  const rendered: string[] = [];
  for (const node of findRoot(parseXml(presentation), 'presentation')) {
    if (!has(node, 'sldIdLst')) continue;
    for (const sldId of children(node, 'sldIdLst')) {
      const path = targets.get(attr(sldId, 'id') ?? '');
      const xml = path === undefined ? null : zipText(entries, path);
      if (path === undefined || xml === null) continue;
      const blocks: Block[] = [];
      const titles: string[] = [];
      collect(shapeTree(xml, 'sld'), blocks, titles);
      const notesRel = readRels(entries, path).find((rel) => rel.type.endsWith('/notesSlide'));
      const notesXml = notesRel === undefined ? null : zipText(entries, notesRel.target);
      const slide: Slide = {
        title: titles.join(' '),
        paragraphs: blocks.map((b) => b.text),
        notes: notesXml === null ? '' : readNotes(notesXml),
      };
      slides.push(slide);
      rendered.push(renderSlide(slide, blocks, slides.length));
    }
  }
  return { markdown: rendered.join('\n\n'), pages: slides.length, json: { slides } };
}
