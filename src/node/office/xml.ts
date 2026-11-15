import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  trimValues: false,
  parseTagValue: false,
});

export function parseXml(text: string): unknown[] {
  return parser.parse(text) as unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function children(node: unknown, tag: string): unknown[] {
  if (!isRecord(node)) return [];
  const found = node[tag];
  return Array.isArray(found) ? found : [];
}

export function attr(node: unknown, name: string): string | undefined {
  if (!isRecord(node)) return undefined;
  const attrs = node[':@'];
  if (!isRecord(attrs)) return undefined;
  const value = attrs[`@_${name}`];
  return value === undefined ? undefined : String(value);
}

export function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isRecord(node)) return '';
  let out = '';
  for (const [key, value] of Object.entries(node)) {
    if (key === ':@') continue;
    if (key === '#text') out += String(value);
    else out += textOf(value);
  }
  return out;
}
