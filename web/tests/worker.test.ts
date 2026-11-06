import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBoosters } from '@core/boosters/pipeline';
import { countTokens } from '@core/tokens';
import type { LocalBoosterId } from '@core/types';
import { handleDistill } from '../src/worker/distill.worker';

const mixed = readFileSync(join(process.cwd(), 'tests/fixtures/mixed.md'), 'utf8');

describe('handleDistill', () => {
  it('runs the requested boosters and counts tokens before and after', () => {
    const active: LocalBoosterId[] = ['ws', 'tables'];
    const result = handleDistill(mixed, active);
    expect(result.out).toBe(runBoosters(mixed, new Set(active)));
    expect(result.rawTokens).toBe(countTokens(mixed));
    expect(result.outTokens).toBe(countTokens(result.out));
    expect(result.outTokens).toBeLessThan(result.rawTokens);
  });

  it('returns the raw text untouched when no booster is active', () => {
    const result = handleDistill(mixed, []);
    expect(result.out).toBe(mixed);
    expect(result.outTokens).toBe(result.rawTokens);
  });
});
