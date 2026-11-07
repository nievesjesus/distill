import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DistillError } from '../node/errors';
import { isInside } from '../node/inside';

async function realpathOfExistingAncestor(absolute: string): Promise<string> {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export async function resolveRoots(roots: string[], cwd: string): Promise<string[]> {
  return Promise.all(
    roots.map(async (root) => {
      const absolute = resolve(cwd, root);
      try {
        return await realpath(absolute);
      } catch {
        throw new DistillError('not_found', `Root not found: ${absolute}`);
      }
    }),
  );
}

export function rootResolver(roots: string[], cwd: string): (p: string) => Promise<string> {
  let realRoots: Promise<string[]> | undefined;
  return async (p) => {
    realRoots ??= resolveRoots(roots, cwd);
    const allowed = await realRoots;
    const absolute = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch (error) {
      const anchored = await realpathOfExistingAncestor(absolute);
      if (!allowed.some((root) => isInside(anchored, root))) {
        throw new DistillError('forbidden', 'Path is outside the allowed roots');
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      throw new DistillError('not_found', `File not found: ${absolute}`);
    }
    if (!allowed.some((root) => isInside(real, root))) {
      throw new DistillError('forbidden', 'Path is outside the allowed roots');
    }
    return real;
  };
}

export function cwdResolver(cwd: string): (p: string) => Promise<string> {
  return async (p) => (isAbsolute(p) ? p : resolve(cwd, p));
}
