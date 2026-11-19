import { posix } from 'node:path';
import { DistillError } from '../errors';
import { readZip } from '../office/zip';
import { attr, parseXml, textOf } from '../office/xml';
import { htmlFragmentToMarkdown, sourceHeader } from './extract';

const OBFUSCATION: ReadonlySet<string> = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc']);
const DRM = 'This EPUB is DRM-protected';
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const MAX_CHAPTERS = 3000;

export interface EpubDeps {
  now?: () => Date;
  label?: string;
}

export interface EpubResult {
  markdown: string;
  pages: number;
  json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kidsOf(node: unknown, tag: string): unknown[] {
  return isRecord(node) && Array.isArray(node[tag]) ? (node[tag] as unknown[]) : [];
}

function findAll(nodes: unknown[], tag: string, out: unknown[] = []): unknown[] {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (tag in node) out.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key !== ':@' && Array.isArray(value)) findAll(value, tag, out);
    }
  }
  return out;
}

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

function resolve(base: string, href: string): string {
  const clean = href.split('#')[0] ?? '';
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {}
  return posix.normalize(posix.join(posix.dirname(base), decoded));
}

function assertNotProtected(files: Map<string, Uint8Array>): void {
  if (files.has('META-INF/rights.xml')) throw new DistillError('parse_failed', DRM);
  const encryption = files.get('META-INF/encryption.xml');
  if (!encryption) return;
  const methods = findAll(parseXml(decode(encryption)), 'EncryptionMethod');
  for (const method of methods) {
    const algorithm = attr(method, 'Algorithm');
    if (algorithm === undefined || !OBFUSCATION.has(algorithm)) throw new DistillError('parse_failed', DRM);
  }
}

interface Manifest {
  href: string;
  type: string;
  properties: string;
}

function tocFromNav(xml: string, base: string): Map<string, string> {
  const titles = new Map<string, string>();
  const navs = findAll(parseXml(xml), 'nav');
  const nav = navs.find((node) => /\btoc\b/.test(attr(node, 'type') ?? '')) ?? navs[0];
  if (!nav) return titles;
  for (const link of findAll(kidsOf(nav, 'nav'), 'a')) {
    const href = attr(link, 'href');
    const title = textOf(kidsOf(link, 'a')).replace(/\s+/g, ' ').trim();
    if (!href || title === '') continue;
    const key = resolve(base, href);
    if (!titles.has(key)) titles.set(key, title);
  }
  return titles;
}

function tocFromNcx(xml: string, base: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const point of findAll(parseXml(xml), 'navPoint')) {
    const label = findAll(kidsOf(point, 'navPoint'), 'navLabel')[0];
    const content = findAll(kidsOf(point, 'navPoint'), 'content')[0];
    const src = attr(content, 'src');
    const title = textOf(kidsOf(label, 'navLabel')).replace(/\s+/g, ' ').trim();
    if (!src || title === '') continue;
    const key = resolve(base, src);
    if (!titles.has(key)) titles.set(key, title);
  }
  return titles;
}

function headingsShifted(markdown: string, shift: number, minLevel: number): string {
  let fence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) fence = !fence;
      if (fence) return line;
      const match = HEADING.exec(line);
      if (!match) return line;
      const level = Math.min(6, Math.max(minLevel, (match[1] as string).length + shift));
      return `${'#'.repeat(level)} ${match[2]}`;
    })
    .join('\n');
}

function leadingHeading(markdown: string): { level: number; text: string; rest: string } | null {
  const lines = markdown.split('\n');
  const at = lines.findIndex((line) => line.trim() !== '');
  if (at < 0) return null;
  const match = HEADING.exec(lines[at] as string);
  if (!match) return null;
  return { level: (match[1] as string).length, text: (match[2] as string).trim(), rest: lines.slice(at + 1).join('\n') };
}

function minHeadingLevel(markdown: string): number | null {
  let fence = false;
  let min: number | null = null;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) continue;
    const match = HEADING.exec(line);
    if (match) min = Math.min(min ?? 6, (match[1] as string).length);
  }
  return min;
}

const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

function chapterMarkdown(body: string, tocTitle: string | undefined, fallback: string): string {
  const markdown = htmlFragmentToMarkdown(body);
  if (markdown === '') return '';
  const lead = leadingHeading(markdown);
  if (lead && (tocTitle === undefined || same(lead.text, tocTitle))) {
    return `## ${lead.text}\n\n${headingsShifted(lead.rest, 2 - lead.level, 3).trim()}`.trim();
  }
  const min = minHeadingLevel(markdown);
  const shifted = min === null ? markdown : headingsShifted(markdown, 3 - min, 3);
  return `## ${tocTitle ?? fallback}\n\n${shifted}`.trim();
}

export async function readEpub(bytes: Uint8Array, deps: EpubDeps = {}): Promise<EpubResult> {
  const files = readZip(bytes);
  assertNotProtected(files);

  const container = files.get('META-INF/container.xml');
  if (!container) throw new DistillError('parse_failed', 'This file is not a valid EPUB (no container.xml)');
  const rootfile = findAll(parseXml(decode(container)), 'rootfile')[0];
  const opfPath = attr(rootfile, 'full-path');
  const opfBytes = opfPath ? files.get(opfPath) : undefined;
  if (!opfPath || !opfBytes) throw new DistillError('parse_failed', 'This file is not a valid EPUB (no package file)');

  const opf = parseXml(decode(opfBytes));
  const pkg = findAll(opf, 'package')[0];
  const metadata = findAll(kidsOf(pkg, 'package'), 'metadata')[0];
  const metaText = (tag: string): string => textOf(kidsOf(findAll(kidsOf(metadata, 'metadata'), tag)[0], tag)).replace(/\s+/g, ' ').trim();
  const title = metaText('title');
  const creator = metaText('creator');

  const manifest = new Map<string, Manifest>();
  for (const item of findAll(kidsOf(findAll(kidsOf(pkg, 'package'), 'manifest')[0], 'manifest'), 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (id && href) manifest.set(id, { href, type: attr(item, 'media-type') ?? '', properties: attr(item, 'properties') ?? '' });
  }

  const spineNode = findAll(kidsOf(pkg, 'package'), 'spine')[0];
  const order = findAll(kidsOf(spineNode, 'spine'), 'itemref')
    .map((ref) => attr(ref, 'idref'))
    .filter((id): id is string => id !== undefined);

  let titles = new Map<string, string>();
  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  const ncxId = attr(spineNode, 'toc');
  const ncx = (ncxId ? manifest.get(ncxId) : undefined) ?? [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml');
  try {
    const navBytes = nav ? files.get(resolve(opfPath, nav.href)) : undefined;
    const ncxBytes = ncx ? files.get(resolve(opfPath, ncx.href)) : undefined;
    if (navBytes && nav) titles = tocFromNav(decode(navBytes), resolve(opfPath, nav.href));
    if (titles.size === 0 && ncxBytes && ncx) titles = tocFromNcx(decode(ncxBytes), resolve(opfPath, ncx.href));
  } catch {}

  const chapters: string[] = [];
  for (const id of order.slice(0, MAX_CHAPTERS)) {
    const item = manifest.get(id);
    if (!item || !/x?html/i.test(item.type)) continue;
    const path = resolve(opfPath, item.href);
    const data = files.get(path);
    if (!data) continue;
    const fallback = posix.basename(path).replace(/\.[^.]+$/, '');
    const chapter = chapterMarkdown(decode(data), titles.get(path), fallback);
    if (chapter !== '') chapters.push(chapter);
  }
  if (chapters.length === 0) throw new DistillError('parse_failed', 'This EPUB has no readable chapters');

  const head = [`# ${title || deps.label || 'EPUB'}`, ...(creator ? [`Author: ${creator}`] : [])].join('\n\n');
  const header = sourceHeader(deps.label ?? 'book.epub', (deps.now ?? (() => new Date()))(), 'converted', 'epub');
  const markdown = `${header}\n\n${head}\n\n${chapters.join('\n\n')}\n`;
  return { markdown, pages: chapters.length, json: { format: 'epub', title, creator, chapters: chapters.length, markdown } };
}
