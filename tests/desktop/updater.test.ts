import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDesktopUpdater, desktopVariant } from '../../desktop/updater';
import type { UpdaterLike } from '../../desktop/updater';
import type { DesktopUpdateStatus } from '../../src/core/types';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = false;
  disableDifferentialDownload = false;
  logger: unknown = console;
  downloads = 0;
  installs = 0;
  checkResult: () => Promise<unknown> = async () => undefined;
  private current: string | null = null;

  get channel(): string | null {
    return this.current;
  }

  set channel(value: string | null) {
    this.current = value;
    this.allowDowngrade = true;
  }

  checkForUpdates(): Promise<unknown> {
    return this.checkResult();
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    return undefined;
  }

  quitAndInstall(): void {
    this.installs += 1;
  }
}

function setup() {
  const updater = new FakeUpdater();
  const seen: DesktopUpdateStatus[] = [];
  const desktop = createDesktopUpdater({ updater, variant: 'lite', onStatus: (status) => seen.push(status) });
  return { updater, desktop, seen };
}

describe('createDesktopUpdater', () => {
  it('configures notify-only lite channel', () => {
    const { updater, desktop } = setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.channel).toBe('lite');
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.logger).toBeNull();
    expect(desktop.status()).toEqual({ state: 'idle' });
  });

  it('maps events to statuses', () => {
    const { updater, desktop, seen } = setup();
    updater.emit('checking-for-update');
    expect(desktop.status()).toEqual({ state: 'checking' });
    updater.emit('update-available', { version: '0.2.0' });
    expect(desktop.status()).toEqual({ state: 'available', version: '0.2.0' });
    updater.emit('download-progress', { percent: 41.6 });
    expect(desktop.status()).toEqual({ state: 'downloading', version: '0.2.0', percent: 42 });
    updater.emit('update-downloaded', { version: '0.2.0' });
    expect(desktop.status()).toEqual({ state: 'ready', version: '0.2.0' });
    updater.emit('update-not-available');
    expect(desktop.status()).toEqual({ state: 'none' });
    expect(seen.map((s) => s.state)).toEqual(['checking', 'available', 'downloading', 'ready', 'none']);
  });

  it('download only after available', async () => {
    const { updater, desktop } = setup();
    await desktop.download();
    expect(updater.downloads).toBe(0);
    updater.emit('update-available', { version: '0.2.0' });
    await desktop.download();
    expect(updater.downloads).toBe(1);
  });

  it('install only when ready', () => {
    const { updater, desktop } = setup();
    desktop.install();
    updater.emit('update-available', { version: '0.2.0' });
    desktop.install();
    expect(updater.installs).toBe(0);
    updater.emit('update-downloaded', { version: '0.2.0' });
    desktop.install();
    expect(updater.installs).toBe(1);
  });

  it('errors become status', async () => {
    const { updater, desktop } = setup();
    updater.checkResult = async () => {
      throw new Error('offline');
    };
    await desktop.check();
    expect(desktop.status()).toEqual({ state: 'error', error: 'offline' });
    updater.emit('error', new Error('x'.repeat(500)));
    expect(desktop.status().error).toHaveLength(200);
  });

  it('retries the download after an error that followed an available version', async () => {
    const { updater, desktop } = setup();
    updater.emit('update-available', { version: '0.2.0' });
    updater.emit('error', new Error('network'));
    await desktop.download();
    expect(updater.downloads).toBe(1);
  });

  it('does not download after an error without a version', async () => {
    const { updater, desktop } = setup();
    updater.emit('error', new Error('network'));
    await desktop.download();
    expect(updater.downloads).toBe(0);
  });
});

describe('desktopVariant', () => {
  it('is full when the lingua folder exists and lite otherwise', () => {
    expect(desktopVariant('/res', (p) => p === join('/res', 'lingua'))).toBe('full');
    expect(desktopVariant('/res', () => false)).toBe('lite');
  });
});
