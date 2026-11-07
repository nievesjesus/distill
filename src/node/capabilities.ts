import { access, constants } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

const MACOS_SOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
const WINDOWS_PROGRAM_FILES_VARIABLES = ['ProgramFiles', 'ProgramFiles(x86)'];

export interface CapabilityProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => Promise<boolean>;
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function sofficeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const names = platform === 'win32' ? ['soffice.exe', 'libreoffice.exe'] : ['soffice', 'libreoffice'];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const candidates = dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
  if (platform === 'darwin') candidates.push(MACOS_SOFFICE);
  if (platform === 'win32') {
    for (const variable of WINDOWS_PROGRAM_FILES_VARIABLES) {
      const root = env[variable];
      if (root) candidates.push(path.join(root, 'LibreOffice', 'program', 'soffice.exe'));
    }
  }
  return candidates;
}

export async function hasLibreOffice(probe: CapabilityProbe = {}): Promise<boolean> {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const isExecutable = probe.isExecutable ?? defaultIsExecutable;
  const results = await Promise.all(sofficeCandidates(platform, env).map(isExecutable));
  return results.some(Boolean);
}

export async function exposeLibreOffice(probe: CapabilityProbe = {}): Promise<boolean> {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const isExecutable = probe.isExecutable ?? defaultIsExecutable;
  const path = platform === 'win32' ? win32 : posix;
  const candidates = sofficeCandidates(platform, env);
  const results = await Promise.all(candidates.map(isExecutable));
  const index = results.findIndex(Boolean);
  if (index === -1) return false;
  const directory = path.dirname(candidates[index]);
  const key = platform === 'win32' && env.PATH === undefined && env.Path !== undefined ? 'Path' : 'PATH';
  const entries = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  if (!entries.includes(directory)) env[key] = [...entries, directory].join(path.delimiter);
  return true;
}
