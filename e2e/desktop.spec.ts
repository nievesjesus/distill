import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
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
