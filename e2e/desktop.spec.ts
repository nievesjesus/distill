import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
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

test('desktop shell loads the UI, converts a PDF through the LiteParse fork and exits cleanly', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'distill-desktop-'));
  const pdfPath = join(workDir, 'sample-report.pdf');
  writeFileSync(pdfPath, makeSamplePdf(sampleLines()));

  const packagedApp = process.env.DISTILL_APP_PATH;
  const app = await electron.launch(packagedApp ? { executablePath: packagedApp } : { args: ['.'] });
  const child = app.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  try {
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

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((window) => window.close());
    });
    await Promise.race([
      exited,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('electron did not exit within 5s')), 5_000)),
    ]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(workDir, { recursive: true, force: true });
  }
});

function launch(userDataDir: string): Promise<ElectronApplication> {
  const packagedApp = process.env.DISTILL_APP_PATH;
  const userData = `--user-data-dir=${userDataDir}`;
  return electron.launch(packagedApp ? { executablePath: packagedApp, args: [userData] } : { args: ['.', userData] });
}

async function quit(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.close())).catch(() => undefined);
  try {
    await Promise.race([
      exited,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('electron did not exit within 5s')), 5_000)),
    ]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
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

test('desktop window adapts to its size and keeps the footer in view', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'distill-userdata-'));
  const workDir = mkdtempSync(join(tmpdir(), 'distill-desktop-'));
  const files = Array.from({ length: 12 }, (_, index) => {
    const path = join(workDir, `doc-${index}.pdf`);
    writeFileSync(path, makeSamplePdf(sampleLines()));
    return path;
  });
  const app = await launch(userData);
  try {
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
  } finally {
    await quit(app);
    rmSync(workDir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test('detailed mode with options open keeps the footer inside a minimum window', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'distill-userdata-'));
  const workDir = mkdtempSync(join(tmpdir(), 'distill-desktop-'));
  const pdf = join(workDir, 'one.pdf');
  writeFileSync(pdf, makeSamplePdf(sampleLines()));
  const app = await launch(userData);
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Fewer tokens')).toBeVisible();
    expect(await resize(app, 440, 520)).toEqual([440, 520]);
    await page.locator('input[type="file"]').setInputFiles(pdf);
    await page.getByRole('button', { name: 'Detailed' }).click();
    await expect(page.locator('.booster-list')).toBeVisible();
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('.footer')?.getBoundingClientRect();
      const list = document.querySelector('.file-list')?.getBoundingClientRect();
      return { footerTop: footer?.top ?? -1, footerBottom: footer?.bottom ?? -1, listHeight: list?.height ?? -1, innerHeight: window.innerHeight };
    });
    expect(layout.footerTop).toBeGreaterThanOrEqual(0);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.innerHeight);
    expect(layout.listHeight).toBeGreaterThan(0);
    await page.screenshot({ path: shot('440x520-detailed') });
  } finally {
    await quit(app);
    rmSync(workDir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test('connect drawer stays clear of the window controls', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'distill-userdata-'));
  const app = await launch(userData);
  try {
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
  } finally {
    await quit(app);
    rmSync(userData, { recursive: true, force: true });
  }
});

test('desktop window remembers its size between launches', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'distill-userdata-'));
  try {
    const first = await launch(userData);
    const firstPage = await first.firstWindow();
    await expect(firstPage.getByText('Fewer tokens')).toBeVisible();
    expect(await resize(first, 700, 640)).toEqual([700, 640]);
    await quit(first);

    const second = await launch(userData);
    const secondPage = await second.firstWindow();
    await expect(secondPage.getByText('Fewer tokens')).toBeVisible();
    const restored = await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    expect(restored).toEqual([700, 640]);
    await quit(second);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
