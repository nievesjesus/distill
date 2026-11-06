import type { BoosterMeta, LocalBoosterId } from '../types';
import { dropRepeatedBoilerplate } from './dedupe';
import { slimMedia } from './media';
import { compactTables } from './tables';
import { collapseWhitespace } from './ws';

export const BOOSTERS: readonly BoosterMeta[] = [
  { id: 'dedupe', name: 'Drop repeated boilerplate', hint: 'running headers, page numbers', lossy: false, estimate: 0.09 },
  { id: 'media', name: 'Slim images and links', hint: 'keep alt and link text', lossy: false, estimate: 0.05 },
  { id: 'tables', name: 'Compact tables', hint: 'strip alignment padding', lossy: false, estimate: 0.14 },
  { id: 'ws', name: 'Collapse whitespace', hint: 'blank lines, padding', lossy: false, estimate: 0.06 },
  { id: 'lingua', name: 'LLMLingua-2', hint: 'lossy, local model', lossy: true, estimate: 0.45 },
];

export const BOOSTER_ORDER: readonly LocalBoosterId[] = ['dedupe', 'media', 'tables', 'ws'];

export const DEFAULT_ACTIVE: ReadonlySet<LocalBoosterId> = new Set(BOOSTER_ORDER);

const TRANSFORMS: Record<LocalBoosterId, (md: string) => string> = {
  dedupe: dropRepeatedBoilerplate,
  media: slimMedia,
  tables: compactTables,
  ws: collapseWhitespace,
};

export function runBoosters(md: string, active: ReadonlySet<LocalBoosterId>): string {
  const steps = BOOSTER_ORDER.filter((id) => active.has(id));
  if (steps.length === 0) return md;
  return steps.reduce((current, id) => TRANSFORMS[id](current), md.replace(/\r\n/g, '\n'));
}
