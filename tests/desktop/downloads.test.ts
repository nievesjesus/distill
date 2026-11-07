import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  REVEAL_CHANNEL,
  SAVED_CHANNEL,
  createDownloadHandler,
  createRevealHandler,
  createSavedRegistry,
  readPrefs,
  saveDialogOptions,
  writePrefs,
} from '../../desktop/downloads';

const DOWNLOADS = '/home/me/Downloads';

describe('saveDialogOptions', () => {
  it('defaults to the last used folder when it still exists', () => {
    const options = saveDialogOptions('a.md', '/work/notes', DOWNLOADS, () => true);
    expect(options.defaultPath).toBe(join('/work/notes', 'a.md'));
  });

  it('falls back to Downloads when the last folder is gone or unknown', () => {
    expect(saveDialogOptions('a.md', '/gone', DOWNLOADS, () => false).defaultPath).toBe(join(DOWNLOADS, 'a.md'));
    expect(saveDialogOptions('a.md', undefined, DOWNLOADS, () => true).defaultPath).toBe(join(DOWNLOADS, 'a.md'));
  });

  it.each([
    ['report.md', 'Markdown', ['md']],
    ['bundle.zip', 'ZIP archive', ['zip']],
    ['doc.json', 'JSON', ['json']],
    ['UPPER.MD', 'Markdown', ['md']],
  ])('filters %s by its extension', (filename, name, extensions) => {
    expect(saveDialogOptions(filename, undefined, DOWNLOADS, () => false).filters).toEqual([{ name, extensions }]);
  });

  it('adds no filter for an unknown extension', () => {
    expect(saveDialogOptions('notes.txt', undefined, DOWNLOADS, () => false).filters).toBeUndefined();
  });

  it('keeps accents, spaces and emoji in the suggested name', () => {
    const options = saveDialogOptions('Informe Año 📊.md', undefined, DOWNLOADS, () => false);
    expect(options.defaultPath).toBe(join(DOWNLOADS, 'Informe Año 📊.md'));
  });
});

describe('prefs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-prefs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips the last folder atomically', () => {
    const file = join(dir, 'nested', 'desktop-prefs.json');
    writePrefs(file, { lastDir: '/work/notes' });
    expect(readPrefs(file)).toEqual({ lastDir: '/work/notes' });
    expect(readdirSync(join(dir, 'nested'))).toEqual(['desktop-prefs.json']);
  });

  it('reads defaults from a missing, corrupt or wrongly shaped file', () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ lastDir: 42 }));
    expect(readPrefs(join(dir, 'missing.json'))).toEqual({});
    expect(readPrefs(corrupt)).toEqual({});
    expect(readPrefs(wrong)).toEqual({});
  });

});

describe('createSavedRegistry', () => {
  it('maps issued ids to paths and rejects anything else', () => {
    const registry = createSavedRegistry();
    const id = registry.add('/tmp/a.md');
    expect(registry.resolve(id)).toBe('/tmp/a.md');
    expect(registry.resolve('/tmp/a.md')).toBeUndefined();
    expect(registry.resolve('nope')).toBeUndefined();
    expect(registry.add('/tmp/a.md')).not.toBe(id);
  });

  it('forgets the oldest ids past its cap', () => {
    const registry = createSavedRegistry(2);
    const first = registry.add('/1');
    registry.add('/2');
    registry.add('/3');
    expect(registry.resolve(first)).toBeUndefined();
  });
});

class FakeItem extends EventEmitter {
  savePath: string | undefined;
  cancelled = false;
  constructor(private readonly filename: string) {
    super();
  }
  getFilename() {
    return this.filename;
  }
  setSavePath(path: string) {
    this.savePath = path;
  }
  cancel() {
    this.cancelled = true;
  }
}

function setup(chosen: string | undefined, options: { prefsFile?: string; exists?: (path: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-dl-'));
  const prefsFile = options.prefsFile ?? join(dir, 'desktop-prefs.json');
  const showSaveDialogSync = vi.fn(() => chosen);
  const showItemInFolder = vi.fn();
  const downloadFinished = vi.fn();
  const send = vi.fn();
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } } as unknown as BrowserWindow;
  const registry = createSavedRegistry();
  const deps = {
    dialog: { showSaveDialogSync },
    shell: { showItemInFolder },
    downloadsDir: DOWNLOADS,
    prefsFile,
    exists: options.exists ?? (() => true),
    dock: { downloadFinished },
    registry,
  };
  return { dir, prefsFile, showSaveDialogSync, showItemInFolder, downloadFinished, send, window, registry, deps };
}

describe('createDownloadHandler', () => {
  it('asks where to save, sets the path, remembers the folder and announces completion', () => {
    const ctx = setup('/work/notes/out.md');
    const item = new FakeItem('out.md');
    createDownloadHandler(ctx.deps)(item, ctx.window);
    expect(ctx.showSaveDialogSync).toHaveBeenCalledWith(ctx.window, expect.objectContaining({ defaultPath: join(DOWNLOADS, 'out.md') }));
    expect(item.savePath).toBe('/work/notes/out.md');
    expect(item.cancelled).toBe(false);
    expect(readPrefs(ctx.prefsFile)).toEqual({ lastDir: '/work/notes' });
    expect(ctx.send).not.toHaveBeenCalled();

    item.emit('done', {}, 'completed');
    expect(ctx.downloadFinished).toHaveBeenCalledWith('/work/notes/out.md');
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = ctx.send.mock.calls[0] as [string, { id: string; filename: string }];
    expect(channel).toBe(SAVED_CHANNEL);
    expect(payload.filename).toBe('out.md');
    expect(ctx.registry.resolve(payload.id)).toBe('/work/notes/out.md');
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('uses the remembered folder as the next default', () => {
    const ctx = setup('/work/notes/out.md');
    writePrefs(ctx.prefsFile, { lastDir: '/work/notes' });
    createDownloadHandler(ctx.deps)(new FakeItem('again.zip'), ctx.window);
    expect(ctx.showSaveDialogSync).toHaveBeenCalledWith(
      ctx.window,
      expect.objectContaining({ defaultPath: join('/work/notes', 'again.zip'), filters: [{ name: 'ZIP archive', extensions: ['zip'] }] }),
    );
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('cancels and writes nothing when the dialog is dismissed', () => {
    const ctx = setup(undefined);
    const item = new FakeItem('out.md');
    createDownloadHandler(ctx.deps)(item, ctx.window);
    expect(item.cancelled).toBe(true);
    expect(item.savePath).toBeUndefined();
    expect(readPrefs(ctx.prefsFile)).toEqual({});
    item.emit('done', {}, 'cancelled');
    expect(ctx.send).not.toHaveBeenCalled();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('does not announce an interrupted download', () => {
    const ctx = setup('/work/out.md');
    const item = new FakeItem('out.md');
    createDownloadHandler(ctx.deps)(item, ctx.window);
    item.emit('done', {}, 'interrupted');
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.downloadFinished).not.toHaveBeenCalled();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('never blocks on an unreadable or unwritable prefs file', () => {
    const ctx = setup('/work/out.md', { prefsFile: join('/dev/null', 'nope', 'prefs.json') });
    const item = new FakeItem('out.md');
    expect(() => createDownloadHandler(ctx.deps)(item, ctx.window)).not.toThrow();
    expect(item.savePath).toBe('/work/out.md');
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('does not message a destroyed window', () => {
    const ctx = setup('/work/out.md');
    const item = new FakeItem('out.md');
    const gone = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: ctx.send } } as unknown as BrowserWindow;
    createDownloadHandler(ctx.deps)(item, gone);
    item.emit('done', {}, 'completed');
    expect(ctx.send).not.toHaveBeenCalled();
    rmSync(ctx.dir, { recursive: true, force: true });
  });
});

describe('createRevealHandler', () => {
  it('reveals only ids the main process issued', () => {
    const registry = createSavedRegistry();
    const showItemInFolder = vi.fn();
    const reveal = createRevealHandler({ shell: { showItemInFolder }, registry });
    const id = registry.add('/work/out.md');
    expect(reveal(id)).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith('/work/out.md');
    showItemInFolder.mockClear();
    expect(reveal('/etc/passwd')).toBe(false);
    expect(reveal(42)).toBe(false);
    expect(reveal(undefined)).toBe(false);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('exposes distinct channel names', () => {
    expect(REVEAL_CHANNEL).not.toBe(SAVED_CHANNEL);
  });
});
