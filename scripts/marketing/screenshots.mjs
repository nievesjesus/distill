import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { docsDir, makeDemoDocs } from './make-demo-docs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = join(root, '.github', 'assets');
const cache = join(root, '.cache', 'marketing');
const viewport = { width: 640, height: 780 };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not become healthy');
}

async function dropAndWait(page, files) {
  await page.locator('input[type=file]').setInputFiles(files);
  const rows = page.getByRole('listitem');
  await rows.first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    (count) => document.querySelectorAll('.file-list .file-saved').length >= count,
    files.length,
    { timeout: 120_000 },
  );
}

async function readSavings(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.file-list > li')].map((row) => ({
      name: row.querySelector('.file-name')?.textContent?.trim() ?? '',
      tokens: row.querySelector('.file-tokens')?.textContent?.trim() ?? '',
      saved: row.querySelector('.file-saved')?.textContent?.trim() ?? '',
    }));
    const footerPercent = document.querySelector('.footer-pct')?.textContent?.trim() ?? '';
    return { rows, footerPercent, footerText: document.querySelector('.footer')?.textContent?.trim() ?? '' };
  });
}

async function settle(page, ms = 500) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

async function shoot(page, file) {
  await page.setViewportSize({ width: viewport.width, height: 400 });
  await settle(page, 200);
  const bottom = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.body > *')];
    return Math.ceil(Math.max(...nodes.map((node) => node.getBoundingClientRect().bottom)) + window.scrollY);
  });
  await page.setViewportSize({ width: viewport.width, height: Math.max(bottom + 36, 520) });
  await page.mouse.move(0, 0);
  await settle(page, 500);
  await page.screenshot({ path: join(assets, file) });
  await page.setViewportSize(viewport);
}

const server = { child: null };

async function main() {
  mkdirSync(assets, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const files = await makeDemoDocs();
  if (!existsSync(join(root, 'dist', 'cli.js'))) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  server.child = spawn('node', ['dist/cli.js', '--no-open', '--port', String(port)], { cwd: root, stdio: 'inherit' });
  await waitForHealth(origin);

  const browser = await chromium.launch();
  const open = async (options = {}) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'dark', ...options });
    const page = await context.newPage();
    await page.goto(origin);
    return { context, page };
  };

  const shots = await open();
  const page = shots.page;
  await page.getByText('Nothing distilled yet').waitFor();
  await dropAndWait(page, files);
  await settle(page, 800);
  const measured = await readSavings(page);

  const firstToggle = page.locator('.file-list .file-toggle').first();
  const collapseAll = async () => {
    const open = page.locator('.file-list .file-toggle[aria-expanded=true]');
    while ((await open.count()) > 0) await open.first().click();
  };
  await collapseAll();
  await settle(page, 400);
  await shoot(page, 'screenshot-compact.png');

  await firstToggle.click();
  await page.locator('.preview').waitFor();
  await page.mouse.move(0, 0);
  await settle(page, 400);
  await shoot(page, 'screenshot-preview.png');
  await collapseAll();

  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await page.locator('.booster-list').waitFor({ state: 'visible' });
  await page.mouse.move(0, 0);
  await settle(page, 600);
  await shoot(page, 'screenshot-detailed.png');
  await shots.context.close();

  const videoDir = join(cache, 'video-tmp');
  rmSync(videoDir, { recursive: true, force: true });
  const flow = await open({ deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: viewport } });
  const fp = flow.page;
  await fp.getByText('Nothing distilled yet').waitFor();
  await fp.waitForTimeout(1800);
  await fp.locator('input[type=file]').setInputFiles(files);
  await fp.waitForFunction(() => document.querySelectorAll('.file-list .file-saved').length >= 5, null, { timeout: 120_000 });
  await fp.waitForTimeout(2200);
  const master = fp.getByRole('switch', { name: 'Optimize for LLMs' });
  await master.click();
  await fp.waitForTimeout(2000);
  await master.click();
  await fp.waitForFunction(() => document.querySelectorAll('.file-list .file-saved').length >= 5, null, { timeout: 120_000 });
  await fp.waitForTimeout(2200);
  const video = fp.video();
  await flow.context.close();
  const recorded = await video.path();
  const target = join(cache, 'flow.webm');
  rmSync(target, { force: true });
  renameSync(recorded, target);
  rmSync(videoDir, { recursive: true, force: true });

  await browser.close();

  const rowPercents = measured.rows.map((row) => Number(row.saved.replace(/[^\d]/g, '')));
  const overall = Number(measured.footerPercent.replace(/[^\d]/g, ''));
  const result = { ...measured, overallPercent: overall, headline: measured.rows[0] ?? null, rowPercents, files: readdirSync(docsDir) };
  writeFileSync(join(cache, 'measured.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} finally {
  server.child?.kill();
}
