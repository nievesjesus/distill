import { parentPort, workerData } from 'node:worker_threads';
import { SearchQueryError, searchMarkdown } from './core/search';
import type { SearchOptions } from './core/search';

const { markdown, query, opts } = workerData as { markdown: string; query: string; opts: SearchOptions };

try {
  parentPort?.postMessage({ ok: true, result: searchMarkdown(markdown, query, opts) });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    queryError: error instanceof SearchQueryError,
  });
}
