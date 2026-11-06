import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { makeSamplePdf } from '../tests/fixtures/make-pdf';

const PAGE_HEADER = 'Example Co. — Report   Page 1 of 3';

function sampleLines(): string[] {
  const lines: string[] = [];
  for (let page = 0; page < 6; page += 1) {
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
