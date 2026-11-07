import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const ACCENT = '#C8F53C';
const ON_ACCENT = '#0B0B10';
const GLYPH_PATHS = [
  'M12 3c3.6 4.3 6.2 7.6 6.2 10.8a6.2 6.2 0 0 1-12.4 0C5.8 10.6 8.4 7.3 12 3z',
  'M9.5 15h5',
];
const GLYPH_STROKE = 2.4;
const GLYPH_RATIO = 14 / 24;
const CORNER_RATIO = 0.225;

function iconSvg(size, inset) {
  const square = size - inset * 2;
  const glyph = square * GLYPH_RATIO;
  const scale = glyph / 24;
  const offset = (size - glyph) / 2;
  const paths = GLYPH_PATHS.map((d) => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect x="${inset}" y="${inset}" width="${square}" height="${square}" rx="${square * CORNER_RATIO}" fill="${ACCENT}"/>
<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${ON_ACCENT}" stroke-width="${GLYPH_STROKE}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
</svg>`;
}

async function render(browser, size, inset, target) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${iconSvg(size, inset)}`);
  await page.screenshot({ path: target, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
}

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
mkdirSync(new URL('../web/public/', import.meta.url), { recursive: true });
const browser = await chromium.launch();
try {
  await render(browser, 1024, 100, new URL('../build/icon.png', import.meta.url).pathname);
  await render(browser, 64, 2, new URL('../web/public/favicon.png', import.meta.url).pathname);
} finally {
  await browser.close();
}
