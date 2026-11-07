import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { DistillError } from '../node/errors';

async function realpathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new DistillError('not_found', `File not found: ${path}`);
    }
    throw error;
  }
}

function isInside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

export function rootResolver(roots: string[], cwd: string): (p: string) => Promise<string> {
  const realRoots = Promise.all(roots.map((root) => realpathOf(resolve(cwd, root))));
  return async (p) => {
    const absolute = isAbsolute(p) ? p : resolve(cwd, p);
    const real = await realpathOf(absolute);
    if (!(await realRoots).some((root) => isInside(real, root))) {
      throw new DistillError('forbidden', 'Path is outside the allowed roots');
    }
    return real;
  };
}

export function cwdResolver(cwd: string): (p: string) => Promise<string> {
  return async (p) => (isAbsolute(p) ? p : resolve(cwd, p));
}
