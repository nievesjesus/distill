import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { SearchQueryError, searchMarkdown } from '../core/search';
import type { SearchOptions, SearchResult } from '../core/search';
import { builtWorkerPath } from './worker-path';

export const REGEX_TIMEOUT_MS = 2000;

type WorkerReply = { ok: true; result: SearchResult } | { ok: false; message: string; queryError?: boolean };

export async function searchMarkdownBounded(
  markdown: string,
  query: string,
  opts: SearchOptions = {},
  run: { timeoutMs?: number; workerPath?: string } = {},
): Promise<SearchResult> {
  if (!opts.regex) return searchMarkdown(markdown, query, opts);
  searchMarkdown('', query, opts);
  const path = run.workerPath ?? builtWorkerPath('search-worker.js');
  if (!existsSync(path)) return searchMarkdown(markdown, query, opts);
  const timeoutMs = run.timeoutMs ?? REGEX_TIMEOUT_MS;
  const seconds = timeoutMs / 1000;
  return new Promise<SearchResult>((resolve, reject) => {
    const worker = new Worker(path, { workerData: { markdown, query, opts } });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new SearchQueryError(`The regex took longer than ${seconds} s and was stopped; use a simpler pattern or a plain query`)));
    }, timeoutMs);
    worker.once('message', (reply: WorkerReply) => {
      finish(() => {
        if (reply.ok) resolve(reply.result);
        else reject(reply.queryError ? new SearchQueryError(reply.message) : new Error(reply.message));
      });
    });
    worker.once('error', (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
    worker.once('exit', (code) => finish(() => reject(new Error(`The search worker exited without a result (code ${code})`))));
  });
}
