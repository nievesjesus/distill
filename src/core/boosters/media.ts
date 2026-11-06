import { mapProse } from './segments';

const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;

export function slimProse(prose: string): string {
  return prose
    .replace(IMAGE, (_match, alt: string) => (alt === '' ? '' : `[${alt}]`))
    .replace(LINK, '$1');
}

export function slimMedia(md: string): string {
  return mapProse(md, slimProse);
}
