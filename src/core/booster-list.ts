import { BOOSTER_ORDER } from './boosters/pipeline';
import type { LocalBoosterId } from './types';

export function parseBoosterList(value: string): Set<LocalBoosterId> {
  const ids = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const known: readonly string[] = BOOSTER_ORDER;
  const unknown = ids.find((id) => !known.includes(id));
  if (unknown !== undefined) throw new Error(`Unknown booster: ${unknown}. Valid: ${BOOSTER_ORDER.join(', ')}`);
  return new Set(ids as LocalBoosterId[]);
}
