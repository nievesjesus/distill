import { existsSync } from 'node:fs';
import { app, BrowserWindow, dialog, session, shell } from 'electron';
import type { WebContents } from 'electron';
import { startServer } from '../src/server/start';
import { isAllowedExternal, isPermissionAllowed, isSameOrigin, tessdataDir, windowOptions } from './window';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let server: { url: string; close(): Promise<void> } | null = null;
let appUrl = '';
let closing = false;

function openExternal(url: string): void {
  if (isAllowedExternal(url)) void shell.openExternal(url);
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

function createWindow(url: string): BrowserWindow {
  const window = new BrowserWindow(windowOptions());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });
  window.loadURL(url).catch(failStartup);
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

  app.on('window-all-closed', async () => {
    if (closing) return;
    closing = true;
    try {
      await server?.close();
    } finally {
      app.quit();
    }
  });

  app.whenReady().then(boot).catch(failStartup);
}
