import { XMLParser } from 'fast-xml-parser';
import { DistillError } from '../errors';
import { htmlFragmentToMarkdown, sourceHeader } from './extract';

const MAX_ENTRIES = 500;
const MAX_SUMMARY = 600;
const ARRAY_TAGS: ReadonlySet<string> = new Set(['item', 'entry', 'link']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

export interface FeedDeps {
  now?: () => Date;
  label?: string;
}

export interface FeedResult {
  markdown: string;
  pages: number;
  json: unknown;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (isNode(value)) return textOf(value['#text']);
  return '';
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

function linkOf(value: unknown): string {
  const links = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const pick =
    links.find((link) => isNode(link) && (link['@_rel'] === undefined || link['@_rel'] === 'alternate') && typeof link['@_href'] === 'string') ??
    links.find((link) => isNode(link) && typeof link['@_href'] === 'string') ??
    links.find((link) => typeof link === 'string' || (isNode(link) && typeof link['#text'] === 'string'));
  if (pick === undefined) return '';
  return isNode(pick) && typeof pick['@_href'] === 'string' ? pick['@_href'] : textOf(pick).trim();
}

function dateOf(value: string): string {
  if (value === '') return '';
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString().slice(0, 10);
}

function summaryOf(value: unknown): string {
  const raw = textOf(value).trim();
  if (raw === '') return '';
  const text = /<[a-z][\s\S]*>/i.test(raw) ? htmlFragmentToMarkdown(raw) : raw;
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  return clean.length > MAX_SUMMARY ? `${clean.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : clean;
}

interface Entry {
  title: string;
  date: string;
  link: string;
  summary: string;
}

function entryOf(node: unknown): Entry | null {
  if (!isNode(node)) return null;
  const entry: Entry = {
    title: flat(textOf(node.title)),
    date: dateOf(flat(textOf(node.pubDate ?? node.published ?? node.updated ?? node.date))),
    link: linkOf(node.link) || flat(textOf(node.guid)).replace(/^(?!https?:\/\/).*/, ''),
    summary: summaryOf(node.summary ?? node.description ?? node.content ?? node.encoded),
  };
  return entry.title === '' && entry.link === '' && entry.summary === '' ? null : entry;
}

export function readFeed(bytes: Uint8Array, deps: FeedDeps = {}): FeedResult {
  let doc: Node;
  try {
    doc = parser.parse(Buffer.from(bytes).toString('utf8')) as Node;
  } catch (error) {
    throw new DistillError('parse_failed', 'Could not read the XML file', { cause: error });
  }
  const root = isNode(doc.rss) ? (doc.rss.channel as unknown) : isNode(doc.feed) ? doc.feed : isNode(doc.RDF) ? doc.RDF : null;
  const channel = Array.isArray(root) ? root[0] : root;
  if (!isNode(channel)) throw new DistillError('parse_failed', 'This XML file is not an RSS or Atom feed');
  const rdfChannel = isNode(doc.RDF) && isNode(doc.RDF.channel) ? doc.RDF.channel : channel;
  const rawEntries = (Array.isArray(channel.item) ? channel.item : []).concat(Array.isArray(channel.entry) ? channel.entry : []);
  const entries = rawEntries.map(entryOf).filter((entry): entry is Entry => entry !== null);
  const title = flat(textOf(rdfChannel.title)) || deps.label || 'Feed';
  const description = summaryOf(rdfChannel.description ?? rdfChannel.subtitle);
  const lines = [sourceHeader(deps.label ?? 'feed', (deps.now ?? (() => new Date()))(), 'converted', 'feed'), '', `# ${title}`];
  if (description !== '') lines.push('', description);
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    lines.push('', `## ${entry.title || entry.link || '(untitled)'}`, '');
    if (entry.date !== '') lines.push(`- Date: ${entry.date}`);
    if (entry.link !== '') lines.push(`- Link: ${entry.link}`);
    if (entry.summary !== '') lines.push('', entry.summary);
  }
  if (entries.length > MAX_ENTRIES) lines.push('', `(${entries.length - MAX_ENTRIES} more entries not shown)`);
  const markdown = `${lines.join('\n')}\n`;
  return { markdown, pages: 1, json: { format: 'feed', title, entries: entries.slice(0, MAX_ENTRIES), markdown } };
}
