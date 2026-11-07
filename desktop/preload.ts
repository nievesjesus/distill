import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { REVEAL_CHANNEL, SAVED_CHANNEL } from './channels';

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
});
