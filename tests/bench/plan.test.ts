import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', name)).href);

const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

describe('buildPlan', () => {
  it('covers task x arm x repeat exactly once', async () => {
    const { buildPlan } = await load('plan.mjs');
    const plan = buildPlan({ tasks, arms: ['baseline', 'distill'], repeats: 2, seed: 's' });
    expect(plan).toHaveLength(20);
    expect(new Set(plan.map((u: { task: { id: string }; arm: string; repeat: number }) => `${u.task.id}|${u.arm}|${u.repeat}`)).size).toBe(20);
  });

  it('multiplies by scenarios and tags every unit', async () => {
    const { buildPlan } = await load('plan.mjs');
    const plan = buildPlan({ tasks, arms: ['baseline', 'distill'], repeats: 1, seed: 's', scenarios: ['dev', 'clean'] });
    expect(plan).toHaveLength(20);
    expect(plan.filter((u: { scenario: string }) => u.scenario === 'clean')).toHaveLength(10);
  });

  it('is deterministic per seed and differs across seeds', async () => {
    const { buildPlan } = await load('plan.mjs');
    const ids = (seed: string) => buildPlan({ tasks, arms: ['baseline', 'distill'], repeats: 1, seed }).map((u: { task: { id: string }; arm: string }) => `${u.task.id}${u.arm[0]}`).join();
    expect(ids('2026-11-19')).toBe(ids('2026-11-19'));
    expect(ids('2026-11-19')).not.toBe(ids('2026-11-20'));
  });

  it('interleaves arms instead of running one arm first', async () => {
    const { buildPlan } = await load('plan.mjs');
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` }));
    const plan = buildPlan({ tasks: many, arms: ['baseline', 'distill'], repeats: 1, seed: 'x' });
    const firstHalf = plan.slice(0, 40).filter((u: { arm: string }) => u.arm === 'distill').length;
    expect(firstHalf).toBeGreaterThan(5);
    expect(firstHalf).toBeLessThan(35);
  });
});

describe('limitPaired', () => {
  const units = (ids: string[], arms = ['baseline', 'distill'], scenario = 'dev') => ids.flatMap((id) => arms.map((arm) => ({ task: { id }, arm, repeat: 1, scenario })));

  it('keeps whole groups in plan order and never splits one', async () => {
    const { limitPaired } = await load('plan.mjs');
    const shuffled = [units(['a'])[0], units(['b'])[0], units(['a'])[1], units(['b'])[1], units(['c'])[0], units(['c'])[1]];
    const picked = limitPaired(shuffled, 5);
    expect(picked.map((u: { task: { id: string }; arm: string }) => `${u.task.id}${u.arm[0]}`)).toEqual(['ab', 'aa'.replace('aa', 'ad'), 'bb', 'bd']);
  });

  it('treats scenarios and repeats as separate groups', async () => {
    const { limitPaired } = await load('plan.mjs');
    const both = [...units(['a'], ['baseline', 'distill'], 'dev'), ...units(['a'], ['baseline', 'distill'], 'clean')];
    expect(limitPaired(both, 2)).toHaveLength(2);
    expect(limitPaired(both, 4)).toHaveLength(4);
    expect(limitPaired(both, 1)).toHaveLength(0);
  });

  it('keeps everything when the cap is large', async () => {
    const { limitPaired } = await load('plan.mjs');
    expect(limitPaired(units(['a', 'b']), Number.POSITIVE_INFINITY)).toHaveLength(4);
  });
});

describe('resume and budget helpers', () => {
  it('treats ok records and second attempts as finished', async () => {
    const { finishedKeys, unitKey } = await load('plan.mjs');
    const base = { night: 'n', task: 't', arm: 'baseline', repeat: 1, model: 'm' };
    expect(finishedKeys([{ ...base, ok: false, attempt: 1 }]).size).toBe(0);
    expect(finishedKeys([{ ...base, ok: true, attempt: 1 }]).has(unitKey('n', 't', 'baseline', 1, 'm'))).toBe(true);
    expect(finishedKeys([{ ...base, ok: false, attempt: 2 }]).has(unitKey('n', 't', 'baseline', 1, 'm'))).toBe(true);
    expect(finishedKeys([{ ...base, ok: true, scenario: 'clean' }]).has(unitKey('n', 't', 'baseline', 1, 'm', 'clean'))).toBe(true);
    expect(finishedKeys([{ ...base, ok: true, scenario: 'clean' }]).has(unitKey('n', 't', 'baseline', 1, 'm', 'dev'))).toBe(false);
  });

  it('sums cost per night and stops at the limit', async () => {
    const { nightCost, budgetReached } = await load('plan.mjs');
    const records = [
      { night: 'a', costUsd: 1.5 },
      { night: 'a', costUsd: 0.5 },
      { night: 'b', costUsd: 9 },
    ];
    expect(nightCost(records, 'a')).toBe(2);
    expect(budgetReached(2, 2)).toBe(true);
    expect(budgetReached(1.99, 2)).toBe(false);
    expect(budgetReached(100, Number.POSITIVE_INFINITY)).toBe(false);
    expect(nightCost([{ night: 'a', costUsd: 1, scenario: 'clean' }, { night: 'a', costUsd: 2 }], 'a', 'dev')).toBe(2);
    expect(nightCost([{ night: 'a', costUsd: 1, scenario: 'clean' }, { night: 'a', costUsd: 2 }], 'a', 'clean')).toBe(1);
  });
});

describe('parseArgs', () => {
  it('applies defaults and parses values', async () => {
    const { parseArgs } = await load('args.mjs');
    const a = parseArgs(['--tasks', 'tag:simple', '--repeats', '3', '--max-runs=4', '--arms', 'distill', '--resume']);
    expect(a).toMatchObject({ tasks: 'tag:simple', repeats: 3, 'max-runs': 4, arms: ['distill'], resume: true, model: 'sonnet', 'max-cost-usd': 20, package: 'distill-llm@latest' });
  });

  it('rejects unknown options, bad numbers and unknown arms', async () => {
    const { parseArgs } = await load('args.mjs');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option');
    expect(() => parseArgs(['--repeats', 'x'])).toThrow('valid number');
    expect(() => parseArgs(['--arms', 'other'])).toThrow('Unknown arm');
    expect(() => parseArgs(['--model'])).toThrow('needs a value');
  });
});

describe('acquireLock', () => {
  it('refuses a second holder and releases cleanly', async () => {
    const { acquireLock } = await load('lock.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'distill-bench-lock-'));
    try {
      const path = join(dir, '.lock');
      const release = acquireLock(path);
      expect(release).toBeTypeOf('function');
      expect(acquireLock(path)).toBeNull();
      release();
      const again = acquireLock(path);
      expect(again).toBeTypeOf('function');
      again();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes over a stale lock', async () => {
    const { acquireLock } = await load('lock.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'distill-bench-lock-'));
    try {
      const path = join(dir, '.lock');
      writeFileSync(path, '999999');
      const release = acquireLock(path);
      expect(release).toBeTypeOf('function');
      release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
