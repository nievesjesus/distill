import { join } from 'node:path';
import type { DesktopUpdateStatus } from '../src/core/types';

const MAX_ERROR_LENGTH = 200;

export interface UpdaterLike extends NodeJS.EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  disableDifferentialDownload: boolean;
  logger: unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface DesktopUpdater {
  status(): DesktopUpdateStatus;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void;
}

export function desktopVariant(resourcesPath: string, exists: (path: string) => boolean): 'lite' | 'full' {
  return exists(join(resourcesPath, 'lingua')) ? 'full' : 'lite';
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

export function createDesktopUpdater(opts: {
  updater: UpdaterLike;
  variant: 'lite' | 'full';
  onStatus: (status: DesktopUpdateStatus) => void;
}): DesktopUpdater {
  const { updater } = opts;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.channel = opts.variant;
  updater.allowDowngrade = false;
  updater.disableDifferentialDownload = true;
  updater.logger = null;

  let current: DesktopUpdateStatus = { state: 'idle' };
  let knownVersion: string | undefined;

  const set = (next: DesktopUpdateStatus): void => {
    current = next;
    opts.onStatus(next);
  };
  const fail = (error: unknown): void => set({ state: 'error', error: messageOf(error) });

  updater.on('checking-for-update', () => set({ state: 'checking' }));
  updater.on('update-available', (info: { version?: string }) => {
    knownVersion = info.version;
    set({ state: 'available', version: info.version });
  });
  updater.on('update-not-available', () => set({ state: 'none' }));
  updater.on('download-progress', (progress: { percent: number }) =>
    set({ state: 'downloading', version: knownVersion, percent: Math.round(progress.percent) }),
  );
  updater.on('update-downloaded', (info: { version?: string }) => {
    knownVersion = info.version ?? knownVersion;
    set({ state: 'ready', version: knownVersion });
  });
  updater.on('error', fail);

  return {
    status: () => current,
    async check() {
      try {
        await updater.checkForUpdates();
      } catch (error) {
        fail(error);
      }
    },
    async download() {
      const canDownload = current.state === 'available' || (current.state === 'error' && knownVersion !== undefined);
      if (!canDownload) return;
      try {
        await updater.downloadUpdate();
      } catch (error) {
        fail(error);
      }
    },
    install() {
      if (current.state === 'ready') updater.quitAndInstall();
    },
  };
}
