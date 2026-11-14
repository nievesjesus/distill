import { useCallback, useEffect, useState } from 'react';
import type { ApiError, UpdateInfo } from '@core/types';
import { checkUpdateNow, getUpdate, installUpdate, setUpdateEnabled } from '../api';
import { S } from '../strings';

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

  const checkNow = useCallback(async () => {
    try {
      const next = await checkUpdateNow();
      writeDismissed(null);
      setDismissed(null);
      setInfo(next);
    } catch {
      return;
    }
  }, []);

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

  return { info, dismissed, dismiss, checkNow, setEnabled, install };
}

export type UpdateState = ReturnType<typeof useUpdateInfo>;
