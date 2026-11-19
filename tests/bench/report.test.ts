import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', name)).href);

interface Rec {
  night: string;
  task: string;
  doc: string;
  arm: string;
  model: string;
  package: string | null;
  repeat: number;
  attempt: number;
  ok: boolean;
  costUsd: number;
  usage: { input: number; output: number; cacheCreation: number; cacheRead: number };
  numTurns: number;
  durationMs: number;
  distillUsed: boolean;
  correct: boolean | null;
  scenario?: string;
  paths?: string[];
}

function rec(over: Partial<Rec>): Rec {
  return {
    night: '2026-11-19',
    task: 't1',
    doc: 'd1',
    arm: 'baseline',
    model: 'sonnet',
    package: null,
    repeat: 1,
    attempt: 1,
    ok: true,
    costUsd: 1,
    usage: { input: 10, output: 5, cacheCreation: 100, cacheRead: 890 },
    numTurns: 4,
    durationMs: 10_000,
    distillUsed: false,
    correct: true,
    ...over,
  };
}

const distill = (over: Partial<Rec>) => rec({ arm: 'distill', package: 'distill-llm@1.0.0', distillUsed: true, ...over });
const tasks = [
  { id: 't1', doc: 'd1', tags: ['simple'] },
  { id: 't2', doc: 'd2', tags: ['deep', 'table'] },
  { id: 't3', doc: 'd3', tags: ['deep'] },
];

describe('stats', () => {
  it('computes quantiles, median and iqr', async () => {
    const { quantile, median, iqr } = await load('stats.mjs');
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(iqr([1, 2, 3, 4, 5])).toEqual([2, 4]);
    expect(median([])).toBeNull();
    expect(iqr([])).toBeNull();
  });

  it('bootstraps a reproducible interval around the median', async () => {
    const { bootstrapMedianCI, median } = await load('stats.mjs');
    const values = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.1, 0.55];
    const a = bootstrapMedianCI(values, { seed: 'x' });
    const b = bootstrapMedianCI(values, { seed: 'x' });
    expect(a).toEqual(b);
    expect(a[0]).toBeLessThanOrEqual(median(values));
    expect(a[1]).toBeGreaterThanOrEqual(median(values));
    expect(a[0]).toBeGreaterThanOrEqual(0.4);
    expect(a[1]).toBeLessThanOrEqual(1.1);
    expect(bootstrapMedianCI([2, 2, 2], { seed: 'x' })).toEqual([2, 2]);
    expect(bootstrapMedianCI([])).toBeNull();
  });
});

describe('aggregate', () => {
  it('keeps only the last attempt of each unit', async () => {
    const { finalRecords } = await load('aggregate.mjs');
    const finals = finalRecords([rec({ ok: false, attempt: 1, costUsd: 0.1 }), rec({ attempt: 2, costUsd: 0.9 })]);
    expect(finals).toHaveLength(1);
    expect(finals[0].attempt).toBe(2);
  });

  it('summarizes an arm with failures, accuracy and spread', async () => {
    const { summarizeArm } = await load('aggregate.mjs');
    const s = summarizeArm([
      rec({ costUsd: 1, correct: true }),
      rec({ costUsd: 2, correct: false, repeat: 2 }),
      rec({ costUsd: 3, correct: null, repeat: 3 }),
      rec({ ok: false, costUsd: 0.5, repeat: 4, attempt: 2, correct: null }),
    ]);
    expect(s).toMatchObject({ runs: 4, failures: 1, failureRate: 0.25, correct: 1, answered: 2 });
    expect(s.accuracy).toBeCloseTo(1 / 3);
    expect(s.cost.median).toBe(2);
    expect(s.spentUsd).toBeCloseTo(6.5);
    expect(s.inputTokens.median).toBe(1000);
  });

  it('pairs tasks, takes median ratios and lists where distill lost', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const records = [
      rec({ task: 't1', costUsd: 1 }),
      distill({ task: 't1', costUsd: 0.5, usage: { input: 10, output: 5, cacheCreation: 50, cacheRead: 440 } }),
      rec({ task: 't2', doc: 'd2', costUsd: 2 }),
      distill({ task: 't2', doc: 'd2', costUsd: 3, correct: false }),
      rec({ task: 't3', doc: 'd3', costUsd: 1 }),
      distill({ task: 't3', doc: 'd3', costUsd: 0.25 }),
      rec({ night: '2026-11-20', task: 't3', doc: 'd3', costUsd: 1 }),
      distill({ night: '2026-11-20', task: 't3', doc: 'd3', costUsd: 0.75 }),
    ];
    const data = aggregate(records, tasks);
    expect(data.header).toMatchObject({ nights: 2, firstNight: '2026-11-19', lastNight: '2026-11-20', models: ['sonnet'], packages: ['distill-llm@1.0.0'], runs: 8 });
    const byTask = Object.fromEntries(data.scenarios.dev.pairs.map((p: { task: string }) => [p.task, p]));
    expect(byTask.t1.costRatio).toBeCloseTo(0.5);
    expect(byTask.t1.tokenRatio).toBeCloseTo(0.5);
    expect(byTask.t2.costRatio).toBeCloseTo(1.5);
    expect(byTask.t3.costRatio).toBeCloseTo(0.5);
    expect(data.scenarios.dev.overall.cost.tasks).toBe(3);
    expect(data.scenarios.dev.overall.cost.median).toBeCloseTo(0.5);
    expect(data.scenarios.dev.overall.cost.ci95[0]).toBeLessThanOrEqual(data.scenarios.dev.overall.cost.median);
    expect(data.scenarios.dev.lost.map((p: { task: string }) => p.task)).toEqual(['t2']);
    expect(data.scenarios.dev.lost[0].reasons).toEqual(['cost more', 'less accurate']);
    const deep = data.scenarios.dev.byTag.find((t: { tag: string }) => t.tag === 'deep');
    expect(deep.tasks).toBe(2);
    expect(data.scenarios.dev.arms.distill.distillUsedRate).toBe(1);
    expect(data.scenarios.dev.arms.baseline.distillUsedRate).toBe(0);
  });

  it('flags a task where distill was wrong and the baseline right even when cheaper', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const data = aggregate([rec({ costUsd: 2 }), distill({ costUsd: 1, correct: false })], tasks);
    expect(data.scenarios.dev.lost).toHaveLength(1);
    expect(data.scenarios.dev.lost[0].reasons).toEqual(['less accurate']);
  });

  it('keeps scenarios apart and pairs only within a scenario', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const records = [
      rec({ costUsd: 1 }),
      distill({ costUsd: 0.5 }),
      rec({ scenario: 'clean', costUsd: 4 }),
      distill({ scenario: 'clean', costUsd: 8 }),
    ];
    const data = aggregate(records, tasks);
    expect(data.header.scenarios).toEqual(['clean', 'dev']);
    expect(data.scenarios.dev.pairs[0].costRatio).toBeCloseTo(0.5);
    expect(data.scenarios.clean.pairs[0].costRatio).toBeCloseTo(2);
    expect(data.scenarios.dev.lost).toHaveLength(0);
    expect(data.scenarios.clean.lost.map((p: { task: string }) => p.task)).toEqual(['t1']);
    expect(data.scenarios.dev.runs).toBe(2);
  });

  it('treats records without a scenario as dev', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const data = aggregate([rec({})], tasks);
    expect(data.header.scenarios).toEqual(['dev']);
  });

  it('computes the share of runs per path', async () => {
    const { summarizeArm } = await load('aggregate.mjs');
    const s = summarizeArm([
      rec({ paths: ['read', 'bash-other'] }),
      rec({ repeat: 2, paths: ['bash-pdftools'] }),
      rec({ repeat: 3, paths: ['read-pages', 'read-converted'] }),
      rec({ repeat: 4, paths: [] }),
      rec({ repeat: 5, ok: false, paths: ['read'] }),
    ]);
    expect(s.paths.read).toBeCloseTo(0.25);
    expect(s.paths['bash-pdftools']).toBeCloseTo(0.25);
    expect(s.paths['read-converted']).toBeCloseTo(0.25);
    expect(s.paths['mcp-distill']).toBe(0);
  });

  it('skips tasks that failed in one arm', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const data = aggregate([rec({}), distill({ ok: false, correct: null, attempt: 2 })], tasks);
    expect(data.scenarios.dev.pairs).toHaveLength(0);
    expect(data.scenarios.dev.arms.distill.failures).toBe(1);
    expect(data.scenarios.dev.overall.cost.median).toBeNull();
  });
});

describe('renderReport', () => {
  it('renders every section and reports gains and losses honestly', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const { renderReport } = await load('render.mjs');
    const records = [rec({ task: 't2', doc: 'd2', costUsd: 2 }), distill({ task: 't2', doc: 'd2', costUsd: 3, correct: false })];
    const md = renderReport(aggregate(records, tasks));
    for (const heading of ['# distill benchmark report', '## Per arm', '## Paired comparison (distill / baseline)', '## By tag', '## Where distill lost']) expect(md).toContain(heading);
    expect(md).toContain('Nights: 1 (2026-11-19 to 2026-11-19)');
    expect(md).toContain('distill-llm@1.0.0');
    expect(md).toContain('1.50x');
    expect(md).toContain('cost more, less accurate');
    expect(md).toContain('+50.0%');
    expect(md).toContain('### Path taken');
  });

  it('renders each scenario in its own section with its own numbers', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const { renderReport } = await load('render.mjs');
    const records = [rec({ costUsd: 1 }), distill({ costUsd: 0.5 }), rec({ scenario: 'clean', costUsd: 4 }), distill({ scenario: 'clean', costUsd: 8, paths: ['bash-python'] })];
    const md = renderReport(aggregate(records, tasks));
    const clean = md.indexOf('## Scenario clean');
    const dev = md.indexOf('## Scenario dev');
    expect(clean).toBeGreaterThan(-1);
    expect(dev).toBeGreaterThan(clean);
    expect(md.slice(clean, dev)).toContain('2.00x');
    expect(md.slice(clean, dev)).not.toContain('0.50x');
    expect(md.slice(dev)).toContain('0.50x');
    expect(md.slice(dev)).not.toContain('2.00x');
    expect(md).toContain('Python PDF libraries, if installed, are not hidden');
  });

  it('says so when there are no runs', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const { renderReport } = await load('render.mjs');
    expect(renderReport(aggregate([], tasks))).toContain('No runs found yet.');
  });
});

describe('report CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-bench-report-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) => spawnSync(process.execPath, [join(repo, 'bench', 'report.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'home') } });

  it('writes markdown and json next to the results, honouring --since and tolerating bad lines', () => {
    const results = join(dir, 'results');
    mkdirSync(results);
    const lines = [rec({ night: '2026-11-18', task: 'contract-term', costUsd: 9 }), rec({ task: 'contract-term', costUsd: 1 }), distill({ task: 'contract-term', costUsd: 0.5 })].map((r) => JSON.stringify(r));
    writeFileSync(join(results, 'runs.jsonl'), `${lines[0]}\nnot json\n${lines[1]}\n${lines[2]}\n`);
    const out = run(['--results', results, '--since', '2026-11-19']);
    expect(out.status).toBe(0);
    const md = readFileSync(join(results, 'bench-report.md'), 'utf8');
    expect(md).toContain('Nights: 1');
    expect(md).toContain('0.50x');
    const json = JSON.parse(readFileSync(join(results, 'report.json'), 'utf8'));
    expect(json.header.runs).toBe(2);
  });

  it('writes to a custom --out path', () => {
    const results = join(dir, 'results');
    mkdirSync(results);
    writeFileSync(join(results, 'runs.jsonl'), '');
    const target = join(dir, 'custom.md');
    expect(run(['--results', results, '--out', target]).status).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(dir, 'report.json'))).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('No runs found yet.');
  });

  it('rejects a bad --since', () => {
    expect(run(['--since', 'yesterday']).status).toBe(1);
  });
});
