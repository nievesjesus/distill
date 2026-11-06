import { existsSync } from 'node:fs';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { startServer } from '../src/server/start';
import { isAllowedExternal, isSameOrigin, tessdataDir, windowOptions } from './window';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let server: { url: string; close(): Promise<void> } | null = null;
let closing = false;

function openExternal(url: string): void {
  if (isAllowedExternal(url)) void shell.openExternal(url);
}

function createWindow(appUrl: string): BrowserWindow {
  const window = new BrowserWindow(windowOptions());
  window.webContents.on('will-navigate', (event, target) => {
    if (isSameOrigin(target, appUrl)) return;
    event.preventDefault();
    openExternal(target);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });
  void window.loadURL(appUrl);
  return window;
}

async function boot(): Promise<void> {
  const tessdata = tessdataDir(app.isPackaged, process.resourcesPath, existsSync);
  if (tessdata) process.env.DISTILL_TESSDATA = tessdata;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', maxBytes: MAX_UPLOAD_BYTES });
  } catch (error) {
    dialog.showErrorBox('distill could not start', error instanceof Error ? error.message : String(error));
    app.quit();
    return;
  }
  mainWindow = createWindow(server.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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

  void app.whenReady().then(boot);
}
