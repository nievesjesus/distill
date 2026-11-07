import path from 'node:path';

type PathFlavor = Pick<typeof path, 'sep'>;

export function isInside(candidate: string, root: string, flavor: PathFlavor = path): boolean {
  const insensitive = flavor.sep === '\\';
  const left = insensitive ? candidate.toLowerCase() : candidate;
  const base = insensitive ? root.toLowerCase() : root;
  const prefix = base.endsWith(flavor.sep) ? base : `${base}${flavor.sep}`;
  return left === base || left.startsWith(prefix);
}
