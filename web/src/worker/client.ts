import type { LocalBoosterId } from '@core/types';
import DistillWorker from './distill.worker?worker';
import type { DistillRequest, DistillResponse, DistillResult } from './distill.worker';

const RAW_TOKEN_CACHE_LIMIT = 50;

interface Pending {
  resolve: (value: DistillResult) => void;
  reject: (reason: Error) => void;
}

const rawTokenCache = new Map<string, number>();
const pending = new Map<number, Pending>();
let worker: Worker | undefined;
let nextId = 1;

function failAll(message: string): void {
  for (const entry of pending.values()) entry.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new DistillWorker();
  created.onmessage = (event: MessageEvent<DistillResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve({ out: message.out, rawTokens: message.rawTokens, outTokens: message.outTokens });
    else entry.reject(new Error(message.message));
  };
  created.onerror = (event) => {
    failAll(event.message || 'Worker crashed');
    created.terminate();
    worker = undefined;
  };
  worker = created;
  return created;
}

function rememberRawTokens(raw: string, tokens: number): void {
  rawTokenCache.delete(raw);
  rawTokenCache.set(raw, tokens);
  if (rawTokenCache.size > RAW_TOKEN_CACHE_LIMIT) {
    const oldest = rawTokenCache.keys().next().value;
    if (oldest !== undefined) rawTokenCache.delete(oldest);
  }
}

export function distill(raw: string, active: LocalBoosterId[]): Promise<DistillResult> {
  return new Promise<DistillResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve: (result) => {
        rememberRawTokens(raw, result.rawTokens);
        resolve(result);
      },
      reject,
    });
    const request: DistillRequest = { id, raw, active, knownRawTokens: rawTokenCache.get(raw) };
    getWorker().postMessage(request);
  });
}
