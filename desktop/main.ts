import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import type { WebContents } from 'electron';
import { startServer } from '../src/server/start';
import { readSavedState, restoreBounds, writeSavedState } from './window-state';
import type { WindowState } from './window-state';
import {
  WINDOW_DEFAULTS,
  WINDOW_MINIMUMS,
  desktopUrl,
  isAllowedExternal,
  isPermissionAllowed,
  isSameOrigin,
  tessdataDir,
  windowOptions,
} from './window';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 500;
const CLOSE_TIMEOUT_MS = 2000;

let mainWindow: BrowserWindow | null = null;
let server: { url: string; close(): Promise<void> } | null = null;
let appUrl = '';
let shutdown: Promise<void> | null = null;
let shutdownDone = false;

function openExternal(url: string): void {
  if (isAllowedExternal(url)) void shell.openExternal(url);
}

function stopServer(): Promise<void> {
  shutdown ??= Promise.race([
    (server?.close() ?? Promise.resolve()).catch((error: unknown) => console.warn('could not stop server', error)),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]).finally(() => {
    shutdownDone = true;
  });
  return shutdown;
}

function failStartup(error: unknown): void {
  dialog.showErrorBox('distill could not start', error instanceof Error ? error.message : String(error));
  app.quit();
}

function guardContents(contents: WebContents): void {
  const guardNavigation = (event: { url: string; preventDefault(): void }): void => {
    if (isSameOrigin(event.url, appUrl)) return;
    event.preventDefault();
    openExternal(event.url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-frame-navigate', guardNavigation);
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function workAreas() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

function snapshot(window: BrowserWindow): WindowState {
  return {
    ...window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
}

function rememberBounds(window: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined;
  const save = (): void => {
    clearTimeout(timer);
    if (window.isDestroyed()) return;
    try {
      writeSavedState(file, snapshot(window));
    } catch (error) {
      console.warn('could not save window state', error);
    }
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };
  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('close', save);
}

function createWindow(url: string): BrowserWindow {
  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const restored = restoreBounds(readSavedState(stateFile), workAreas(), WINDOW_DEFAULTS, WINDOW_MINIMUMS);
  const { maximized, fullScreen, ...bounds } = restored;
  const window = new BrowserWindow({ ...windowOptions(process.platform), ...bounds });
  window.webContents.on('did-finish-load', () => {
    window.webContents.setVisualZoomLevelLimits(1, 1).catch((error) => console.warn('could not lock pinch zoom', error));
  });
  window.once('ready-to-show', () => {
    if (maximized) window.maximize();
    if (fullScreen) window.setFullScreen(true);
    window.show();
  });
  rememberBounds(window, stateFile);
  window.on('closed', () => {
    mainWindow = null;
  });
  window.loadURL(desktopUrl(url, process.platform)).catch(failStartup);
  return window;
}

async function boot(): Promise<void> {
  const tessdata = tessdataDir(app.isPackaged, process.resourcesPath, existsSync);
  if (tessdata) process.env.DISTILL_TESSDATA = tessdata;
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(isPermissionAllowed(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => isPermissionAllowed(permission));
  server = await startServer({ port: 0, host: '127.0.0.1', maxBytes: MAX_UPLOAD_BYTES });
  appUrl = server.url;
  mainWindow = createWindow(appUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('web-contents-created', (_event, contents) => guardContents(contents));

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    void stopServer().finally(() => app.quit());
  });

  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    void stopServer().finally(() => app.quit());
  });

  app.whenReady().then(boot).catch(failStartup);
}
