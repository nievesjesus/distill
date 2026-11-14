import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import {
  REVEAL_CHANNEL,
  SAVED_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
} from './channels';
import type { DesktopUpdateStatus } from '../src/core/types';

interface SavedPayload {
  id: string;
  filename: string;
}

function toSaved(value: unknown): SavedPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, filename } = value as Partial<SavedPayload>;
  return typeof id === 'string' && typeof filename === 'string' ? { id, filename } : null;
}

contextBridge.exposeInMainWorld('distillDesktop', {
  onSaved(callback: (saved: SavedPayload) => void): () => void {
    const listener = (_event: IpcRendererEvent, value: unknown): void => {
      const saved = toSaved(value);
      if (saved) callback(saved);
    };
    ipcRenderer.on(SAVED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(SAVED_CHANNEL, listener);
    };
  },
  reveal(id: string): void {
    if (typeof id === 'string') ipcRenderer.send(REVEAL_CHANNEL, id);
  },
  updates: {
    get(): Promise<DesktopUpdateStatus> {
      return ipcRenderer.invoke(UPDATE_GET_CHANNEL) as Promise<DesktopUpdateStatus>;
    },
    onStatus(callback: (status: DesktopUpdateStatus) => void): () => void {
      const listener = (_event: IpcRendererEvent, value: unknown): void => {
        if (typeof value === 'object' && value !== null) callback(value as DesktopUpdateStatus);
      };
      ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener);
      };
    },
    check(): void {
      ipcRenderer.send(UPDATE_CHECK_CHANNEL);
    },
    download(): void {
      ipcRenderer.send(UPDATE_DOWNLOAD_CHANNEL);
    },
    install(): void {
      ipcRenderer.send(UPDATE_INSTALL_CHANNEL);
    },
  },
});
