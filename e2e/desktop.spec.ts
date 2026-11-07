import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { makeSamplePdf } from '../tests/fixtures/make-pdf';

const PAGE_HEADER = 'Example Co. - Report   Page 1 of 3';

function sampleLines(): string[] {
  const lines: string[] = [];
  for (let page = 0; page < 3; page += 1) {
    lines.push(PAGE_HEADER, '', '', '', 'Quarterly summary of revenue and costs for the period.', '', '', '');
    lines.push('Item        Amount        Notes', 'Revenue     1200          steady', 'Costs       800           flat', '', '', '');
  }
  return lines;
}

function launch(userDataDir?: string): Promise<ElectronApplication> {
  const packagedApp = process.env.DISTILL_APP_PATH;
  const userData = userDataDir ? [`--user-data-dir=${userDataDir}`] : [];
  return electron.launch(packagedApp ? { executablePath: packagedApp, args: userData } : { args: ['.', ...userData] });
}

const tempDirs: string[] = [];

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `distill-${label}-`));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function quit(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.close())).catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('electron did not exit within 5s')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function closing(app: ElectronApplication, body: () => Promise<void>): Promise<void> {
  let failed = false;
  try {
    await body();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await quit(app);
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

function resize(app: ElectronApplication, width: number, height: number): Promise<number[]> {
  return app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(w, h);
      return window.getSize();
    },
    [width, height],
  );
}

function shot(name: string): string {
  mkdirSync('test-results', { recursive: true });
  return join('test-results', `desktop-${name}.png`);
}

function t16shot(name: string): string {
  mkdirSync('test-results', { recursive: true });
  return join('test-results', `t16-desktop-${name}.png`);
}

function geometry(page: Page) {
  return page.evaluate(() => {
    const footer = document.querySelector('.footer')?.getBoundingClientRect();
    const column = document.querySelector('.body')?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollable: document.body.scrollHeight > document.body.clientHeight,
      innerHeight: window.innerHeight,
      footerBottom: footer?.bottom ?? null,
      columnWidth: column?.width ?? null,
      columnLeft: column?.left ?? null,
    };
  });
}

function stubNativeSave(app: ElectronApplication, target: string | null) {
  return app.evaluate(({ dialog, shell }, chosen) => {
    const state = globalThis as unknown as { __save: { target: string | null; options: Array<{ defaultPath: string }>; revealed: string[] } };
    state.__save = { target: chosen, options: [], revealed: [] };
    dialog.showSaveDialogSync = ((_window: unknown, options: { defaultPath: string }) => {
      state.__save.options.push(options);
      return state.__save.target ?? undefined;
    }) as unknown as typeof dialog.showSaveDialogSync;
    shell.showItemInFolder = (path: string) => {
      state.__save.revealed.push(path);
    };
  }, target);
}

function nativeSaveState(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as { __save: { options: Array<{ defaultPath: string }>; revealed: string[] } }).__save);
}

function setSaveTarget(app: ElectronApplication, target: string | null) {
  return app.evaluate((_electron, chosen) => {
    (globalThis as unknown as { __save: { target: string | null } }).__save.target = chosen;
  }, target);
}

test('desktop shell loads the UI, converts a PDF through the LiteParse fork and exits cleanly', async () => {
  const workDir = tmp('desktop');
  const pdfPath = join(workDir, 'sample-report.pdf');
  writeFileSync(pdfPath, makeSamplePdf(sampleLines()));

  const packagedApp = process.env.DISTILL_APP_PATH;
  const app = await electron.launch(packagedApp ? { executablePath: packagedApp } : { args: ['.'] });
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('distill');
    await expect(page.getByText('Fewer tokens')).toBeVisible();

    const expectedLingua = process.env.DISTILL_EXPECT_LINGUA;
    if (expectedLingua) {
      const health = await page.evaluate(() => fetch('/api/health').then((response) => response.json()));
      expect(health.lingua.installed).toBe(expectedLingua === 'installed');
    }

    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    const row = page.getByRole('listitem').filter({ hasText: 'sample-report.pdf' });
    await expect(row.getByText('PDF', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(row.getByText(/^−\d+%$/)).toBeVisible({ timeout: 60_000 });
  });
});

test('desktop window adapts to its size and keeps the footer in view', async () => {
  const userData = tmp('userdata');
  const workDir = tmp('desktop');
  const files = Array.from({ length: 12 }, (_, index) => {
    const path = join(workDir, `doc-${index}.pdf`);
    writeFileSync(path, makeSamplePdf(sampleLines()));
    return path;
  });
  const app = await launch(userData);
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page.getByText('Fewer tokens')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'desktop');

    expect(await resize(app, 300, 300)).toEqual([440, 520]);
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.getByRole('listitem')).toHaveCount(12);
    await expect(page.locator('.footer')).toBeVisible();
    const small = await geometry(page);
    expect(small.scrollWidth).toBeLessThanOrEqual(small.clientWidth);
    expect(small.bodyScrollable).toBe(false);
    expect(small.footerBottom).toBeLessThanOrEqual(small.innerHeight);
    const listScrolls = await page.locator('.file-list').evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(listScrolls).toBe(true);
    await page.screenshot({ path: shot('440x520') });
    if (process.platform === 'darwin') {
      const mark = await page.locator('.brand-mark').boundingBox();
      expect(mark).not.toBeNull();
      expect(mark!.x).toBeGreaterThanOrEqual(80);
      expect(Math.abs(mark!.y + mark!.height / 2 - 20)).toBeLessThanOrEqual(3);
      await page.screenshot({ path: shot('titlebar-mac'), clip: { x: 0, y: 0, width: 240, height: 40 } });
    }

    await resize(app, 640, 780);
    await page.waitForTimeout(200);
    await page.screenshot({ path: shot('640x780') });

    await resize(app, 1280, 900);
    await page.waitForTimeout(200);
    const wide = await geometry(page);
    expect(wide.columnWidth).toBe(720);
    expect(wide.columnLeft).toBe((wide.clientWidth - 720) / 2);
    expect(wide.footerBottom).toBeLessThanOrEqual(wide.innerHeight);
    await page.screenshot({ path: shot('1280x900') });
  });
});

test('detailed mode with options open keeps the footer inside a minimum window', async () => {
  const userData = tmp('userdata');
  const workDir = tmp('desktop');
  const pdf = join(workDir, 'one.pdf');
  writeFileSync(pdf, makeSamplePdf(sampleLines()));
  const app = await launch(userData);
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page.getByText('Fewer tokens')).toBeVisible();
    expect(await resize(app, 440, 520)).toEqual([440, 520]);
    await page.locator('input[type="file"]').setInputFiles(pdf);
    await page.getByRole('button', { name: 'Detailed' }).click();
    await expect(page.locator('.booster-list')).toBeVisible();
    await page.waitForTimeout(400);
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('.footer')?.getBoundingClientRect();
      const list = document.querySelector('.file-list')?.getBoundingClientRect();
      return { footerTop: footer?.top ?? -1, footerBottom: footer?.bottom ?? -1, listHeight: list?.height ?? -1, innerHeight: window.innerHeight };
    });
    expect(layout.footerTop).toBeGreaterThanOrEqual(0);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.innerHeight);
    expect(layout.listHeight).toBeGreaterThan(0);
    await page.screenshot({ path: shot('440x520-detailed') });
  });
});

test('connect drawer stays clear of the window controls', async () => {
  const userData = tmp('userdata');
  const app = await launch(userData);
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page.getByText('Fewer tokens')).toBeVisible();
    expect(await resize(app, 640, 780)).toEqual([640, 780]);
    await page.getByRole('button', { name: 'Connect' }).click();
    const close = page.getByRole('button', { name: 'Close' });
    await expect(close).toBeVisible();
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.y).toBeGreaterThanOrEqual(40);
    const title = await page.locator('.connect-title').boundingBox();
    expect(title).not.toBeNull();
    if (process.platform === 'darwin') expect(title!.x >= 80 || title!.y >= 40).toBe(true);
    await page.screenshot({ path: shot('640x780-connect') });
  });
});

test('desktop window remembers its size between launches and starts with an empty list', async () => {
  const userData = tmp('userdata');
  const workDir = tmp('desktop');
  const pdf = join(workDir, 'one.pdf');
  writeFileSync(pdf, makeSamplePdf(sampleLines()));
  const first = await launch(userData);
  await closing(first, async () => {
    const firstPage = await first.firstWindow();
    await expect(firstPage.getByText('Fewer tokens')).toBeVisible();
    expect(await resize(first, 700, 640)).toEqual([700, 640]);
    await firstPage.locator('input[type="file"]').setInputFiles(pdf);
    await expect(firstPage.getByRole('listitem')).toHaveCount(1);
  });

  const second = await launch(userData);
  await closing(second, async () => {
    const secondPage = await second.firstWindow();
    await expect(secondPage.getByText('Fewer tokens')).toBeVisible();
    const restored = await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    expect(restored).toEqual([700, 640]);
    await expect(secondPage.getByText('Nothing distilled yet')).toBeVisible();
    await expect(secondPage.getByRole('listitem')).toHaveCount(0);
  });
});

test('empty state fills the free space, centered, without a footer', async () => {
  const userData = tmp('userdata');
  const app = await launch(userData);
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page.getByText('Nothing distilled yet')).toBeVisible();
    await expect(page.locator('.footer')).toHaveCount(0);
    await expect(page.getByText('Drop documents anywhere in this window — they never leave your machine.')).toBeVisible();

    for (const [width, height] of [[440, 520], [640, 780], [1280, 900]]) {
      await resize(app, width, height);
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const state = document.querySelector('.empty-state')!.getBoundingClientRect();
        const optimize = document.querySelector('.optimize')!.getBoundingClientRect();
        const art = document.querySelector('.empty-art')?.getBoundingClientRect();
        const content = document.querySelector('.empty-state')!;
        const first = Array.from(content.children).map((child) => child.getBoundingClientRect()).find((rect) => rect.height > 0)!;
        const last = content.lastElementChild!.getBoundingClientRect();
        return {
          stateTop: state.top,
          stateBottom: state.bottom,
          stateCenterX: state.left + state.width / 2,
          optimizeBottom: optimize.bottom,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          artVisible: art !== undefined && art.width > 0,
          topGap: first.top - state.top,
          bottomGap: state.bottom - last.bottom,
          scrollable: document.documentElement.scrollHeight > window.innerHeight,
        };
      });
      expect(layout.stateTop).toBeGreaterThanOrEqual(layout.optimizeBottom);
      expect(layout.stateBottom).toBeLessThanOrEqual(layout.innerHeight);
      expect(Math.abs(layout.stateCenterX - layout.innerWidth / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.topGap - layout.bottomGap)).toBeLessThanOrEqual(2);
      expect(layout.scrollable).toBe(false);
      expect(layout.artVisible).toBe(height > 600);
      await page.screenshot({ path: t16shot(`empty-${width}x${height}`) });
    }
  });
});

test('native save writes a valid ZIP, remembers the folder, offers reveal and honours Cancel', async () => {
  const userData = tmp('userdata');
  const workDir = tmp('desktop');
  const saveDir = tmp('saved');
  const pdfs = ['sample-report.pdf', 'second-report.pdf'].map((name) => {
    const path = join(workDir, name);
    writeFileSync(path, makeSamplePdf(sampleLines()));
    return path;
  });
  const zipPath = join(saveDir, 'bundle.zip');
  const mdPath = join(saveDir, 'sample-report.md');
  const app = await launch(userData);
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page.getByText('Fewer tokens')).toBeVisible();
    await resize(app, 640, 780);
    await stubNativeSave(app, null);

    await page.locator('input[type="file"]').setInputFiles(pdfs);
    const rows = page.getByRole('listitem');
    await expect(rows.getByText(/^−\d+%$/)).toHaveCount(2, { timeout: 60_000 });

    await page.getByRole('button', { name: 'Download all' }).click();
    await expect.poll(async () => (await nativeSaveState(app)).options.length).toBe(1);
    await page.waitForTimeout(500);
    expect(readdirSync(saveDir)).toEqual([]);
    await expect(page.getByText(/^Saved /)).toHaveCount(0);
    expect(existsSync(join(userData, 'desktop-prefs.json'))).toBe(false);

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Clear 2 files? 2 not saved yet.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText(/not saved yet/)).toHaveCount(0);

    await setSaveTarget(app, zipPath);
    await page.getByRole('button', { name: 'Download all' }).click();
    await expect.poll(() => existsSync(zipPath), { timeout: 15_000 }).toBe(true);
    const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
    expect(Object.keys(entries).sort()).toEqual(['sample-report.md', 'second-report.md']);
    expect(strFromU8(entries['sample-report.md']).length).toBeGreaterThan(0);

    await expect(page.getByText('Saved bundle.zip')).toBeVisible();
    const revealName = process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder';
    await page.screenshot({ path: t16shot('640x780-saved-toast') });
    await page.getByRole('button', { name: revealName }).click();
    await expect.poll(async () => (await nativeSaveState(app)).revealed).toEqual([zipPath]);

    expect(JSON.parse(readFileSync(join(userData, 'desktop-prefs.json'), 'utf8'))).toEqual({ lastDir: dirname(zipPath) });
    await setSaveTarget(app, mdPath);
    await rows.filter({ hasText: 'sample-report.pdf' }).getByRole('button', { name: 'Download Markdown' }).click();
    await expect.poll(() => existsSync(mdPath), { timeout: 15_000 }).toBe(true);
    const calls = (await nativeSaveState(app)).options;
    expect(calls[calls.length - 1].defaultPath).toBe(join(dirname(zipPath), 'sample-report.md'));
    expect(readFileSync(mdPath, 'utf8').length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Remove second-report.pdf' }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove sample-report.pdf' }).click();
    await expect(page.getByText('Nothing distilled yet')).toBeVisible();
    await expect(page.locator('.footer')).toHaveCount(0);
  });
});

test('list management, alignment and confirm in the desktop shell', async () => {
  const userData = tmp('userdata');
  const workDir = tmp('desktop');
  const pdfs = ['alpha.pdf', 'beta.pdf', 'gamma.pdf'].map((name) => {
    const path = join(workDir, name);
    writeFileSync(path, makeSamplePdf(sampleLines()));
    return path;
  });
  const app = await launch(userData);
  await closing(app, async () => {
    const page = await app.firstWindow();
    await expect(page.getByText('Fewer tokens')).toBeVisible();
    await resize(app, 640, 780);
    await page.locator('input[type="file"]').setInputFiles(pdfs);
    await expect(page.locator('.file-saved')).toHaveCount(3, { timeout: 60_000 });
    await page.waitForTimeout(300);

    const guides = await page.evaluate(() => {
      const left = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().left;
      return {
        kind: left('.file .kind'),
        track: left('.track'),
        pct: left('.footer-pct'),
        dropIcon: left('.dropzone-icon'),
        footerRight: document.querySelector('.footer')!.getBoundingClientRect().right,
        optimizeRight: document.querySelector('.optimize')!.getBoundingClientRect().right,
        copyX: Array.from(document.querySelectorAll('.file .file-actions button:first-child')).map((el) => Math.round(el.getBoundingClientRect().left)),
        removeRight: Array.from(document.querySelectorAll('.remove-button')).map((el) => Math.round(el.getBoundingClientRect().right)),
        listLeft: document.querySelector('.file-list')!.getBoundingClientRect().left,
      };
    });
    expect(Math.abs(guides.kind - guides.track)).toBeLessThanOrEqual(1);
    expect(Math.abs(guides.kind - guides.pct)).toBeLessThanOrEqual(1);
    expect(Math.abs(guides.kind - guides.dropIcon)).toBeLessThanOrEqual(1);
    expect(new Set(guides.copyX).size).toBe(1);
    expect(new Set(guides.removeRight).size).toBe(1);
    expect(Math.abs(guides.footerRight - guides.optimizeRight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: t16shot('640x780-files') });

    await page.getByRole('button', { name: 'Remove beta.pdf' }).click();
    await expect(page.getByRole('button', { name: 'Remove gamma.pdf' })).toBeFocused();
    await page.getByRole('button', { name: 'Remove gamma.pdf' }).press('Delete');
    await expect(page.getByRole('button', { name: 'Remove alpha.pdf' })).toBeFocused();

    await page.locator('input[type="file"]').setInputFiles(pdfs.slice(1));
    await expect(page.getByRole('listitem')).toHaveCount(3);
    await expect(page.locator('.file-saved')).toHaveCount(3, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Clear 3 files? 3 not saved yet.')).toBeVisible();
    await page.screenshot({ path: t16shot('640x780-clear-confirm') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Nothing distilled yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'browse', exact: true })).toBeFocused();
  });
});
