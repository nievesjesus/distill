import { join } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';

export function windowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 760,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    title: 'distill',
    backgroundColor: '#0B0B10',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

export function isAllowedExternal(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSameOrigin(target: string, appUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export function tessdataDir(
  isPackaged: boolean,
  resourcesPath: string,
  exists: (path: string) => boolean,
): string | undefined {
  if (!isPackaged) return undefined;
  const dir = join(resourcesPath, 'tessdata');
  return exists(join(dir, 'eng.traineddata')) ? dir : undefined;
}
