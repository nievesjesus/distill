import { detectKind } from '../core/kind';

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function maxBytesFor(name: string, configured: number): number {
  const kind = detectKind(name);
  return kind === 'AUDIO' || kind === 'VIDEO' ? Math.max(configured, MEDIA_MAX_BYTES) : configured;
}
