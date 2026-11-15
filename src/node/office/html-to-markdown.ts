import { escapeText, gfmTable } from './markdown';

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

type Node = Element | string;

const VOID = new Set(['br', 'img', 'hr']);
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
const ATTR = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z]+));/g, (match, dec, hex, name) => {
    if (name !== undefined) return NAMED[name] ?? match;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? '');
  return attrs;
}

function parse(html: string): Element {
  const root: Element = { tag: '', attrs: {}, children: [] };
  const stack: Element[] = [root];
  for (const m of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    if (m[2] === undefined) {
      if (!m[0].startsWith('<!--')) top.children.push(m[0]);
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1] === '/') {
      const at = stack.map((el) => el.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const element: Element = { tag, attrs: parseAttrs(m[3]), children: [] };
    top.children.push(element);
    if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) stack.push(element);
  }
  return root;
}

function inline(nodes: Node[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += escapeText(decode(node).replace(/\s+/g, ' '));
      continue;
    }
    const inner = (): string => inline(node.children);
    switch (node.tag) {
      case 'strong':
      case 'b': {
        const text = inner();
        out += text.trim() === '' ? text : `**${text}**`;
        break;
      }
      case 'em':
      case 'i': {
        const text = inner();
        out += text.trim() === '' ? text : `*${text}*`;
        break;
      }
      case 'a': {
        const text = inner();
        const href = node.attrs.href;
        out += href === undefined || text.trim() === '' ? text : `[${text}](${href})`;
        break;
      }
      case 'br':
        out += '\n';
        break;
      case 'img':
        out += `![${node.attrs.alt ?? ''}]()`;
        break;
      case 'ul':
      case 'ol':
      case 'table':
        out += blocks([node]).join('\n');
        break;
      default:
        out += inner();
    }
  }
  return out;
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function list(node: Element, depth: number): string {
  const marker = node.tag === 'ol' ? '1.' : '-';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  for (const item of node.children) {
    if (typeof item === 'string' || item.tag !== 'li') continue;
    const nested = item.children.filter((c): c is Element => typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol'));
    const rest = item.children.filter((c) => !nested.includes(c as Element));
    lines.push(`${indent}${marker} ${tidy(inline(rest)).replace(/\n/g, ' ')}`);
    for (const sub of nested) lines.push(list(sub, depth + 1));
  }
  return lines.join('\n');
}

function rowsOf(node: Element): string[][] {
  const rows: string[][] = [];
  const walk = (el: Element): void => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'tr') {
        rows.push(
          child.children
            .filter((c): c is Element => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
            .map((cell) => tidy(inline(cell.children)).replace(/\n/g, ' ')),
        );
      } else walk(child);
    }
  };
  walk(node);
  return rows;
}

function blocks(nodes: Node[]): string[] {
  const out: string[] = [];
  let pending: Node[] = [];
  const flush = (): void => {
    const text = tidy(inline(pending));
    if (text !== '') out.push(text);
    pending = [];
  };
  for (const node of nodes) {
    if (typeof node === 'string') {
      pending.push(node);
      continue;
    }
    if (/^h[1-6]$/.test(node.tag)) {
      flush();
      const text = tidy(inline(node.children)).replace(/\n/g, ' ');
      if (text !== '') out.push(`${'#'.repeat(Number(node.tag[1]))} ${text}`);
    } else if (node.tag === 'p') {
      flush();
      const text = tidy(inline(node.children));
      if (text !== '') out.push(text);
    } else if (node.tag === 'ul' || node.tag === 'ol') {
      flush();
      const text = list(node, 0);
      if (text !== '') out.push(text);
    } else if (node.tag === 'table') {
      flush();
      const text = gfmTable(rowsOf(node));
      if (text !== '') out.push(text);
    } else if (node.tag === 'div' || node.tag === 'section' || node.tag === 'blockquote' || node.tag === 'body') {
      flush();
      out.push(...blocks(node.children));
    } else pending.push(node);
  }
  flush();
  return out;
}

export function htmlToMarkdown(html: string): string {
  return blocks(parse(html).children).join('\n\n').replace(/\n{3,}/g, '\n\n');
}
