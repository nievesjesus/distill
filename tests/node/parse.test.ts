import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, joinPages } from '../../src/node/parse';
import { hasLibreOffice } from '../../src/node/capabilities';
import { makeSamplePdf } from '../fixtures/make-pdf';

let dir: string;
let bigPdfPath: string;
const parser = createParser({ poolSize: 1 });
const slow = createParser({ poolSize: 1, timeoutMs: 1 });

async function writeTmp(name: string, data: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'distill-parse-'));
  bigPdfPath = await writeTmp(
    'big.pdf',
    makeSamplePdf(Array.from({ length: 5000 }, (_, i) => `Line number ${i} of the big document`)),
  );
});

afterAll(async () => {
  parser.close();
  slow.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('createParser', () => {
  it('parses a sample pdf to markdown', async () => {
    const p = await writeTmp('sample.pdf', makeSamplePdf(['Quarterly Report', 'Revenue grew']));
    const r = await parser.toMarkdown(p);
    expect(r.pages).toBe(1);
    expect(r.markdown).toContain('Quarterly Report');
  }, 30_000);

  it('returns a structured result for json', async () => {
    const p = await writeTmp('sample-json.pdf', makeSamplePdf(['Quarterly Report']));
    const json = (await parser.toJson(p)) as { pages: unknown[] };
    expect(Array.isArray(json.pages)).toBe(true);
  }, 30_000);

  it('maps corrupt input to parse_failed', async () => {
    const bad = await writeTmp('bad.pdf', Buffer.from('%PDF-1.4 garbage'));
    await expect(parser.toMarkdown(bad)).rejects.toMatchObject({ code: 'parse_failed' });
  }, 30_000);

  it('maps timeouts to timeout', async () => {
    await expect(slow.toMarkdown(bigPdfPath)).rejects.toMatchObject({ code: 'timeout' });
  }, 30_000);
});

describe('hasLibreOffice', () => {
  it('returns a boolean', async () => {
    expect(typeof (await hasLibreOffice())).toBe('boolean');
  });
});

describe('joinPages', () => {
  const page = (pageNum: number, markdown: string, pageLabel?: string) => ({ pageNum, markdown, ...(pageLabel ? { pageLabel } : {}) });

  it('keeps the original text for a single page', () => {
    expect(joinPages([page(1, 'only')], 'original')).toBe('original');
    expect(joinPages([], 'empty')).toBe('empty');
  });

  it('prefixes each page with a marker when there are several', () => {
    expect(joinPages([page(1, 'one'), page(2, 'two')], 'ignored')).toBe('<!-- page 1 -->\n\none\n\n<!-- page 2 -->\n\ntwo');
  });

  it('prefers the page label over the page number', () => {
    expect(joinPages([page(1, 'one', 'i'), page(2, 'two', 'ii')], '')).toBe('<!-- page i -->\n\none\n\n<!-- page ii -->\n\ntwo');
  });
});
