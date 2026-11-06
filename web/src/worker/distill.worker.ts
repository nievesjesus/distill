import { runBoosters } from '@core/boosters/pipeline';
import { countTokens } from '@core/tokens';
import type { LocalBoosterId } from '@core/types';

export interface DistillRequest {
  id: number;
  raw: string;
  active: LocalBoosterId[];
  knownRawTokens?: number;
}

export interface DistillResult {
  out: string;
  rawTokens: number;
  outTokens: number;
}

export type DistillResponse =
  | ({ id: number; ok: true } & DistillResult)
  | { id: number; ok: false; message: string };

export function handleDistill(raw: string, active: LocalBoosterId[], knownRawTokens?: number): DistillResult {
  const out = runBoosters(raw, new Set(active));
  const rawTokens = knownRawTokens ?? countTokens(raw);
  const outTokens = out === raw ? rawTokens : countTokens(out);
  return { out, rawTokens, outTokens };
}

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event: MessageEvent<DistillRequest>) => {
    const { id, raw, active, knownRawTokens } = event.data;
    try {
      self.postMessage({ id, ok: true, ...handleDistill(raw, active, knownRawTokens) } satisfies DistillResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, ok: false, message } satisfies DistillResponse);
    }
  };
}
