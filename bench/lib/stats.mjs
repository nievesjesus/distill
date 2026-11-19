import { seededRandom } from './plan.mjs';

export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function iqr(values) {
  if (values.length === 0) return null;
  return [quantile(values, 0.25), quantile(values, 0.75)];
}

export function bootstrapMedianCI(values, { seed = 'bench', resamples = 2000, level = 0.95 } = {}) {
  if (values.length === 0) return null;
  const random = seededRandom(seed);
  const medians = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample = [];
    for (let j = 0; j < values.length; j += 1) sample.push(values[Math.floor(random() * values.length)]);
    medians.push(median(sample));
  }
  const tail = (1 - level) / 2;
  return [quantile(medians, tail), quantile(medians, 1 - tail)];
}
