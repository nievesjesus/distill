import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { DistillError } from '../node/errors';

function isInside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      if (!allowed.some((root) => isInside(absolute, root))) {
        throw new DistillError('forbidden', 'Path is outside the allowed roots');
      }
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
