import { useCallback, useEffect, useState } from 'react';
import type { ApiError, DesktopUpdateStatus, UpdateInfo } from '@core/types';
import { checkUpdateNow, getUpdate, installUpdate, setUpdateEnabled } from '../api';
import { S } from '../strings';

function desktopUpdates() {
  return window.distillDesktop?.updates;
}

const DISMISS_KEY = 'distill:update-dismissed';
const POLL_MS = 1500;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string | null): void {
  try {
    if (version === null) localStorage.removeItem(DISMISS_KEY);
    else localStorage.setItem(DISMISS_KEY, version);
  } catch {
    return;
  }
}

export function useUpdateInfo() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [desktop, setDesktop] = useState<DesktopUpdateStatus | null>(null);
  const [checkedNow, setCheckedNow] = useState(false);

  useEffect(() => {
    const updates = desktopUpdates();
    if (!updates) return;
    let cancelled = false;
    updates
      .get()
      .then((status) => {
        if (!cancelled) setDesktop((previous) => previous ?? status);
      })
      .catch(() => undefined);
    const off = updates.onStatus((status) => {
      if (!cancelled) setDesktop(status);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getUpdate()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const running = info?.install.state === 'running';
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      getUpdate()
        .then((next) => {
          if (!cancelled) setInfo(next);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running]);

  const dismiss = useCallback((version: string) => {
    writeDismissed(version);
    setDismissed(version);
  }, []);

  const desktopCheck = useCallback(() => {
    writeDismissed(null);
    setDismissed(null);
    setCheckedNow(true);
    desktopUpdates()?.check();
  }, []);

  const desktopDownload = useCallback(() => desktopUpdates()?.download(), []);
  const desktopInstall = useCallback(() => desktopUpdates()?.install(), []);

  const checkNow = useCallback(async () => {
    if (desktopUpdates() && info?.method === 'desktop') {
      desktopCheck();
      return;
    }
    try {
      const next = await checkUpdateNow();
      writeDismissed(null);
      setDismissed(null);
      setInfo(next);
    } catch {
      return;
    }
  }, [info?.method, desktopCheck]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      setInfo(await setUpdateEnabled(enabled));
    } catch {
      return;
    }
  }, []);

  const install = useCallback(async () => {
    try {
      setInfo(await installUpdate());
    } catch (error) {
      const message = (error as Partial<ApiError>).message ?? S.updateFailed;
      setInfo((previous) => (previous ? { ...previous, install: { state: 'failed', error: message } } : previous));
    }
  }, []);

  return { info, dismissed, dismiss, checkNow, setEnabled, install, desktop, checkedNow, desktopCheck, desktopDownload, desktopInstall };
}

export type UpdateState = ReturnType<typeof useUpdateInfo>;
