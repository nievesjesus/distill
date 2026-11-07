import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = join(root, '.github', 'assets');
const cache = join(root, '.cache', 'marketing');
const kTokens = (value) => `${(value / 1000).toFixed(1)}k`;
const query = new URLSearchParams();
const claudePath = join(cache, 'claude-measured.json');
if (existsSync(claudePath)) {
  const { total, docs } = JSON.parse(readFileSync(claudePath, 'utf8'));
  query.set('pct', `\u2212${total.saved}% Claude tokens`);
  query.set('detail', `${kTokens(total.pdfTokens)} \u2192 ${kTokens(total.markdownTokens)} \u00b7 ${docs.length} PDFs`);
  query.set('note', "Raw PDF vs distill Markdown, counted with Anthropic's token API");
} else {
  const measured = JSON.parse(readFileSync(join(cache, 'measured.json'), 'utf8'));
  const tokens = /([\d.]+k)\s*\u2192\s*([\d.]+k)/.exec(measured.footerText);
  if (!tokens) throw new Error(`could not read token totals from "${measured.footerText}"`);
  query.set('pct', measured.footerPercent);
  query.set('detail', `tokens \u00b7 ${tokens[1]} \u2192 ${tokens[2]} \u00b7 ${measured.rows.length} docs`);
}
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
