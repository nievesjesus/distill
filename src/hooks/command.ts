import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface HookCommandDeps {
  which: (bin: string) => string | null;
  version: string;
  npmCommand?: string;
}

export function isEphemeralPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.includes('/node_modules/.bin/') || normalized.includes('/_npx/');
}

export function findOnPath(
  bin: string,
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const suffixes = platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${bin}${suffix}`);
      if (isEphemeralPath(candidate)) continue;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

export function hookCommand(deps: HookCommandDeps): string {
  if (deps.npmCommand === 'exec') return `npx -y distill-llm@${deps.version}`;
  return deps.which('distill-llm') !== null ? 'distill-llm' : `npx -y distill-llm@${deps.version}`;
}
