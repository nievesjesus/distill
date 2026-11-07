import { join } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';

export const WINDOW_DEFAULTS = { width: 640, height: 780 };
export const WINDOW_MINIMUMS = { width: 440, height: 520 };
export const TITLE_BAR_HEIGHT = 40;
const BACKGROUND = '#0B0B10';

function titleBarOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: (TITLE_BAR_HEIGHT - 12) / 2 } };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: BACKGROUND, symbolColor: '#A0A0AE', height: TITLE_BAR_HEIGHT },
    };
  }
  return {};
}

export function windowOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  return {
    ...WINDOW_DEFAULTS,
    minWidth: WINDOW_MINIMUMS.width,
    minHeight: WINDOW_MINIMUMS.height,
    title: 'distill',
    backgroundColor: BACKGROUND,
    show: false,
    ...titleBarOptions(platform),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

export function desktopUrl(appUrl: string, platform: NodeJS.Platform): string {
  const url = new URL(appUrl);
  url.searchParams.set('shell', 'desktop');
  url.searchParams.set('platform', platform);
  return url.toString();
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

export function isPermissionAllowed(permission: string): boolean {
  return permission === 'clipboard-sanitized-write';
}
