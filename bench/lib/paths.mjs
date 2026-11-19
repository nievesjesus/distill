import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function benchDir(env = process.env) {
  const raw = env.DISTILL_BENCH_DIR;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return join(homedir(), '.cache', 'distill-llm', 'bench');
}

export function corpusDir(env = process.env) {
  return join(benchDir(env), 'corpus');
}

export function resultsDir(env = process.env) {
  return join(benchDir(env), 'results');
}

export function logsDir(env = process.env) {
  return join(benchDir(env), 'logs');
}

export function demoDir(env = process.env) {
  const raw = env.DISTILL_BENCH_DEMO_DIR;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return join(repoRoot, '.cache', 'marketing', 'docs');
}
