import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
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

let workDir = '';
let pdfPath = '';

test.beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'distill-e2e-'));
  pdfPath = join(workDir, 'sample-report.pdf');
  writeFileSync(pdfPath, makeSamplePdf(sampleLines()));
});

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('drops a PDF, shows the saving, copies it and resets when optimize is off', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');

  await page.locator('input[type=file]').setInputFiles(pdfPath);

  const row = page.getByRole('listitem').filter({ hasText: 'sample-report.pdf' });
  await expect(row.getByText('PDF', { exact: true })).toBeVisible({ timeout: 60_000 });
  const saving = row.getByText(/^−\d+%$/);
  await expect(saving).toBeVisible({ timeout: 60_000 });
  const percent = Number((await saving.innerText()).replace(/[^\d]/g, ''));
  expect(percent).toBeGreaterThan(0);

  await expect(page.getByRole('status')).toHaveText(/sample-report\.pdf ready, −\d+%/);

  const copy = row.getByRole('button', { name: 'Copy Markdown' });
  await copy.click();
  await expect(row.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.length).toBeGreaterThan(0);

  await page.getByRole('switch', { name: 'Optimize for LLMs' }).click();
  await expect(page.locator('.footer-pct')).toHaveText('0%');
});

test('shows the empty state, removes a row, and clears with a confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await page.goto('/');

  await expect(page.getByText('Nothing distilled yet')).toBeVisible();
  await expect(page.getByText('Drop documents here — they never leave your machine.')).toBeVisible();
  await expect(page.locator('.footer')).toHaveCount(0);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/t16-browser-empty.png' });

  const second = join(workDir, 'second-report.pdf');
  writeFileSync(second, makeSamplePdf(sampleLines()));
  await page.locator('input[type=file]').setInputFiles([pdfPath, second]);
  const rows = page.getByRole('listitem');
  await expect(rows.getByText(/^−\d+%$/)).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByText('Nothing distilled yet')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/t16-browser-files.png' });

  await page.getByRole('button', { name: 'Remove sample-report.pdf' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText('sample-report.pdf removed');
  await expect(page.getByRole('button', { name: 'Remove second-report.pdf' })).toBeFocused();

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Clear 1 file? 1 not saved yet.')).toBeVisible();
  await page.screenshot({ path: 'test-results/t16-browser-clear-confirm.png' });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Nothing distilled yet')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(page.locator('.footer')).toHaveCount(0);
});
