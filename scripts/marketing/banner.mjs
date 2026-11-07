import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = join(root, '.github', 'assets');
const measured = JSON.parse(readFileSync(join(root, '.cache', 'marketing', 'measured.json'), 'utf8'));

const tokens = /([\d.]+k)\s*→\s*([\d.]+k)/.exec(measured.footerText);
if (!tokens) throw new Error(`could not read token totals from "${measured.footerText}"`);
const count = measured.rows.length;
const query = new URLSearchParams({
  pct: measured.footerPercent,
  detail: `tokens · ${tokens[1]} → ${tokens[2]} · ${count} docs`,
});
const url = `${pathToFileURL(join(root, 'scripts', 'marketing', 'banner.html')).href}?${query}`;

const browser = await chromium.launch();
for (const [file, scale] of [['banner.png', 2], ['social-preview.png', 1]]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: scale });
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(assets, file) });
  await context.close();
}
await browser.close();
console.log(`wrote ${join(assets, 'banner.png')} and ${join(assets, 'social-preview.png')}`);
