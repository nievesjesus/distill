import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchQueryError } from '../../src/core/search';
import { searchMarkdownBounded } from '../../src/node/search-bounded';

const FAKE_RESULT = { hits: [{ line: 7, text: 'fake' }], total: 1, truncated: false };

let dir: string;
let okWorker: string;
let spinWorker: string;
let queryErrorWorker: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-search-bounded-'));
  okWorker = join(dir, 'ok.mjs');
  spinWorker = join(dir, 'spin.mjs');
  queryErrorWorker = join(dir, 'query-error.mjs');
  writeFileSync(okWorker, "import { parentPort, workerData } from 'node:worker_threads';\nparentPort.postMessage({ ok: true, result: workerData.opts.fake });\n");
  writeFileSync(spinWorker, 'for (;;) {}\n');
  writeFileSync(queryErrorWorker, "import { parentPort, workerData } from 'node:worker_threads';\nparentPort.postMessage({ ok: false, message: workerData.query, queryError: true });\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('searchMarkdownBounded', () => {
  it('searches a plain query without a worker', async () => {
    const out = await searchMarkdownBounded('hello world\n', 'hello', {}, { workerPath: join(dir, 'missing.mjs') });
    expect(out.total).toBe(1);
  });

  it('rejects an invalid regex before any worker starts', async () => {
    await expect(searchMarkdownBounded('x', '(', { regex: true }, { workerPath: spinWorker, timeoutMs: 5000 })).rejects.toBeInstanceOf(SearchQueryError);
  });

  it('falls back to the in-thread search when the worker file is missing', async () => {
    const out = await searchMarkdownBounded('abc\n', 'a.c', { regex: true }, { workerPath: join(dir, 'missing.mjs') });
    expect(out.total).toBe(1);
  });

  it('resolves with the worker result', async () => {
    const opts = { regex: true, fake: FAKE_RESULT } as never;
    await expect(searchMarkdownBounded('abc\n', 'a', opts, { workerPath: okWorker })).resolves.toEqual(FAKE_RESULT);
  });

  it('stops a worker that never finishes', async () => {
    const started = Date.now();
    const failure = await searchMarkdownBounded('abc\n', 'a', { regex: true }, { workerPath: spinWorker, timeoutMs: 200 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SearchQueryError);
    expect((failure as Error).message).toMatch(/took longer/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('turns a reported query error into a SearchQueryError', async () => {
    await expect(searchMarkdownBounded('abc\n', 'bad query', { regex: true }, { workerPath: queryErrorWorker })).rejects.toThrow(SearchQueryError);
  });
});
