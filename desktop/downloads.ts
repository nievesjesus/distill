import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { BrowserWindow, FileFilter, SaveDialogSyncOptions } from 'electron';
import { SAVED_CHANNEL } from './channels';

export { REVEAL_CHANNEL, SAVED_CHANNEL } from './channels';

const REGISTRY_LIMIT = 50;

const FILTERS: Record<string, FileFilter> = {
  '.md': { name: 'Markdown', extensions: ['md'] },
  '.zip': { name: 'ZIP archive', extensions: ['zip'] },
  '.json': { name: 'JSON', extensions: ['json'] },
};

export interface DesktopPrefs {
  lastDir?: string;
}

export interface SavedPayload {
  id: string;
  filename: string;
}

export interface SavedRegistry {
  add(path: string): string;
  resolve(id: unknown): string | undefined;
}

export interface DownloadItemLike {
  getFilename(): string;
  setSavePath(path: string): void;
  cancel(): void;
  once(event: 'done', listener: (event: unknown, state: string) => void): unknown;
}

export interface DownloadDeps {
  dialog: { showSaveDialogSync(window: BrowserWindow, options: SaveDialogSyncOptions): string | undefined };
  downloadsDir: string;
  prefsFile: string;
  registry: SavedRegistry;
  exists?: (path: string) => boolean;
  dock?: { downloadFinished(path: string): void };
}

export interface RevealDeps {
  shell: { showItemInFolder(path: string): void };
  registry: SavedRegistry;
}

export function saveDialogOptions(
  filename: string,
  lastDir: string | undefined,
  downloadsDir: string,
  exists: (path: string) => boolean,
): SaveDialogSyncOptions {
  const directory = lastDir !== undefined && exists(lastDir) ? lastDir : downloadsDir;
  const filter = FILTERS[extname(filename).toLowerCase()];
  return { defaultPath: join(directory, filename), ...(filter ? { filters: [filter] } : {}) };
}

export function readPrefs(file: string): DesktopPrefs {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const lastDir = typeof parsed === 'object' && parsed !== null ? (parsed as { lastDir?: unknown }).lastDir : undefined;
    return typeof lastDir === 'string' && lastDir !== '' ? { lastDir } : {};
  } catch {
    return {};
  }
}

export function writePrefs(file: string, prefs: DesktopPrefs): void {
  const temp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, JSON.stringify(prefs));
  renameSync(temp, file);
}

export function createSavedRegistry(limit: number = REGISTRY_LIMIT): SavedRegistry {
  const paths = new Map<string, string>();
  return {
    add(path) {
      const id = randomUUID();
      paths.set(id, path);
      while (paths.size > limit) {
        const oldest = paths.keys().next().value as string;
        paths.delete(oldest);
      }
      return id;
    },
    resolve(id) {
      return typeof id === 'string' ? paths.get(id) : undefined;
    },
  };
}

function rememberFolder(file: string, target: string): void {
  try {
    writePrefs(file, { lastDir: dirname(target) });
  } catch (error) {
    console.warn('could not save desktop preferences', error);
  }
}

export function createDownloadHandler(deps: DownloadDeps): (item: DownloadItemLike, window: BrowserWindow) => void {
  const exists = deps.exists ?? existsSync;
  return (item, window) => {
    const filename = item.getFilename();
    const options = saveDialogOptions(filename, readPrefs(deps.prefsFile).lastDir, deps.downloadsDir, exists);
    const target = deps.dialog.showSaveDialogSync(window, options);
    if (!target) {
      item.cancel();
      return;
    }
    item.setSavePath(target);
    rememberFolder(deps.prefsFile, target);
    item.once('done', (_event, state) => {
      if (state !== 'completed') return;
      deps.dock?.downloadFinished(target);
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      const payload: SavedPayload = { id: deps.registry.add(target), filename: basename(target) };
      window.webContents.send(SAVED_CHANNEL, payload);
    });
  };
}

export function createRevealHandler(deps: RevealDeps): (id: unknown) => boolean {
  return (id) => {
    const path = deps.registry.resolve(id);
    if (path === undefined) return false;
    deps.shell.showItemInFolder(path);
    return true;
  };
}
