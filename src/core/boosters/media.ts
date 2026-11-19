import { mapProse } from './segments';

const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const UNDERLINE = /<\/?u\s*>/gi;

function stripUnderline(text: string): string {
  let current = text;
  let next = current.replace(UNDERLINE, '');
  while (next !== current) {
    current = next;
    next = current.replace(UNDERLINE, '');
  }
  return current;
}

export function slimProse(prose: string): string {
  return stripUnderline(prose)
    .replace(IMAGE, (_match, alt: string) => (alt === '' ? '' : `[${alt}]`))
    .replace(LINK, '$1');
}

export function slimMedia(md: string): string {
  return mapProse(md, slimProse);
}
