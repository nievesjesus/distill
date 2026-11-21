import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function builtWorkerPath(name: string, from: string = import.meta.url): string {
  const here = dirname(fileURLToPath(from));
  const beside = join(here, name);
  if (existsSync(beside)) return beside;
  const root = packageRoot(here);
  const built = root ? join(root, 'dist', name) : beside;
  return existsSync(built) ? built : beside;
}
