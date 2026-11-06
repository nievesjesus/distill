export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function savedPercent(raw: number, out: number): number {
  if (raw === 0) return 0;
  return Math.max(0, Math.round((1 - out / raw) * 100));
}
