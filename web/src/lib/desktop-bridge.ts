import { useCallback, useEffect, useRef, useState } from 'react';
import { S } from '../strings';

export interface SavedInfo {
  id: string;
  filename: string;
}

interface DesktopBridge {
  onSaved(callback: (saved: SavedInfo) => void): () => void;
  reveal(id: string): void;
}

declare global {
  interface Window {
    distillDesktop?: DesktopBridge;
  }
}

export const SAVED_NOTICE_MS = 6000;

function extensionOf(filename: string): string {
  return filename.slice(filename.lastIndexOf('.')).toLowerCase();
}

export function useExportTracking(commit: (localIds: string[]) => void) {
  const pending = useRef<{ ids: string[]; extension: string } | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const bridge = window.distillDesktop;
    if (!bridge) return undefined;
    return bridge.onSaved((saved) => {
      const waiting = pending.current;
      if (!waiting || extensionOf(saved.filename) !== waiting.extension) return;
      pending.current = null;
      commitRef.current(waiting.ids);
    });
  }, []);

  return useCallback((localIds: string[], filename?: string) => {
    if (filename === undefined || !window.distillDesktop) {
      commitRef.current(localIds);
      return;
    }
    pending.current = { ids: localIds, extension: extensionOf(filename) };
  }, []);
}

export function revealLabel(): string {
  return document.documentElement.dataset.platform === 'darwin' ? S.showInFinder : S.showInFolder;
}

export function useSavedNotice() {
  const [saved, setSaved] = useState<SavedInfo | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSaved(null);
  }, []);

  useEffect(() => {
    const bridge = window.distillDesktop;
    if (!bridge) return undefined;
    const unsubscribe = bridge.onSaved((next) => {
      if (timer.current) clearTimeout(timer.current);
      setSaved(next);
      timer.current = setTimeout(() => setSaved(null), SAVED_NOTICE_MS);
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const reveal = useCallback(() => {
    if (saved) window.distillDesktop?.reveal(saved.id);
  }, [saved]);

  return { saved, dismiss, reveal };
}
