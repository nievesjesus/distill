import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const MACOS_SOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(): string[] {
  const names = ['soffice', 'libreoffice'];
  return process.platform === 'win32' ? names.map((name) => `${name}.exe`) : names;
}

export async function hasLibreOffice(): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = dirs.flatMap((dir) => candidateNames().map((name) => join(dir, name)));
  if (process.platform === 'darwin') candidates.push(MACOS_SOFFICE);
  const results = await Promise.all(candidates.map(isExecutable));
  return results.some(Boolean);
}
