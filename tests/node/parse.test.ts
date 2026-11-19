import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPage, createParser, joinPages, visualPagesOf } from '../../src/node/parse';
import type { PageComplexity } from '../../src/node/parse';
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

describe('classifyPage', () => {
  const stats = (over: Record<string, unknown> = {}) => ({
    fullPageImage: false,
    largestImageCoverage: 0,
    uncoveredVectorArea: 0,
    layout: { figureCount: 0 },
    ...over,
  });

  it('flags a full-page raster as scan', () => {
    expect(classifyPage(stats({ fullPageImage: true, uncoveredVectorArea: undefined }), 0)).toBe('scan');
  });

  it('prefers scan over figure signals', () => {
    expect(classifyPage(stats({ fullPageImage: true, largestImageCoverage: 0.5, uncoveredVectorArea: 5000 }), 900)).toBe('scan');
  });

  it('flags a vector chart (controls p2 and p4)', () => {
    expect(classifyPage(stats({ uncoveredVectorArea: 18112.5, layout: { figureCount: 1 } }), 1412)).toBe('figure');
    expect(classifyPage(stats({ uncoveredVectorArea: 2050.3125, layout: { figureCount: 1 } }), 2797)).toBe('figure');
  });

  it('flags a raster figure (controls p3)', () => {
    expect(classifyPage(stats({ largestImageCoverage: 0.182, uncoveredVectorArea: undefined }), 1398)).toBe('figure');
  });

  it('flags a chart-only page with almost no text (controls p7)', () => {
    expect(classifyPage(stats({ uncoveredVectorArea: undefined, layout: { figureCount: 1 } }), 12)).toBe('figure');
  });

  it('ignores a tiny logo, a table and plain text (controls p5, p6, demo pages)', () => {
    expect(classifyPage(stats({ largestImageCoverage: 0.0047, uncoveredVectorArea: undefined }), 1397)).toBeNull();
    expect(classifyPage(stats(), 908)).toBeNull();
    expect(classifyPage(stats(), 1788)).toBeNull();
  });

  it('does not treat a figure count on a text-heavy page as a figure', () => {
    expect(classifyPage(stats({ layout: { figureCount: 2 } }), 500)).toBeNull();
  });

  it('treats an undefined vector area as not computed', () => {
    expect(classifyPage(stats({ uncoveredVectorArea: undefined }), 500)).toBeNull();
  });

  it('returns null without complexity', () => {
    expect(classifyPage(undefined, 10)).toBeNull();
  });
});

describe('joinPages visual markers', () => {
  const page = (pageNum: number, markdown: string, complexity?: PageComplexity) => ({ pageNum, markdown, ...(complexity ? { complexity } : {}) });
  const figure = { fullPageImage: false, largestImageCoverage: 0.2, textLength: 900 };
  const scan = { fullPageImage: true, largestImageCoverage: 0, textLength: 0 };

  it('adds the class to the marker', () => {
    expect(joinPages([page(1, 'one'), page(4, 'four', figure), page(7, 'seven', scan)], '')).toBe(
      '<!-- page 1 -->\n\none\n\n<!-- page 4: figure (chart or image not in this text; see the original page) -->\n\nfour\n\n<!-- page 7: scan (OCR text) -->\n\nseven',
    );
  });

  it('adds no marker for a single page even when flagged', () => {
    expect(joinPages([page(1, 'only', figure)], 'original')).toBe('original');
  });

  it('lists visual pages by label', () => {
    expect(visualPagesOf([page(1, 'a'), { ...page(2, 'b', figure), pageLabel: 'ii' }, page(3, 'c', scan)])).toEqual([
      { page: 'ii', kind: 'figure' },
      { page: '3', kind: 'scan' },
    ]);
  });

  it('reports the class of a single page', () => {
    expect(visualPagesOf([page(1, 'only', figure)])).toEqual([{ page: '1', kind: 'figure' }]);
  });
});
