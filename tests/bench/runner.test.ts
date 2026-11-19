import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const sha = 'a'.repeat(64);

let dir: string;
let results: string;
let log: string;
let fake: string;

const task = (id: string, doc: string, value: number, tags = ['simple']) => ({ id, doc, question: `What is ${id}?`, expected: { type: 'number', value }, tags, source: 'test' });
const docEntry = (id: string) => ({ id, url: `https://example.com/${id}.pdf`, sha256: sha, ext: 'pdf', license: 'test', title: id });

function setup(behaviors: Record<string, unknown[]>, tasks = [task('t1', 'd1', 5), task('t2', 'd2', 7)], docs = ['d1', 'd2']) {
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify(docs.map(docEntry)));
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasks));
  writeFileSync(join(dir, 'cfg.json'), JSON.stringify({ log, counter: join(dir, 'counter'), behaviors }));
}

function bench(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [join(repo, 'bench', 'run.mjs'), '--tasks-file', join(dir, 'tasks.json'), '--corpus-file', join(dir, 'corpus.json'), '--results', results, '--claude', fake, '--package', 'distill-llm@9.9.9', '--night', '2026-11-19', ...args],
    { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'bench'), FAKE_CLAUDE_CFG: join(dir, 'cfg.json'), ...extraEnv }, timeout: 60_000 },
  );
}

const records = () =>
  readFileSync(join(results, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const calls = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-bench-runner-'));
  results = join(dir, 'results');
  log = join(dir, 'calls.jsonl');
  fake = join(dir, 'fake-claude.mjs');
  copyFileSync(join(repo, 'tests', 'bench', 'fixtures', 'fake-claude.mjs'), fake);
  chmodSync(fake, 0o755);
  const corpus = join(dir, 'bench', 'corpus');
  mkdirSync(corpus, { recursive: true });
  for (const id of ['d1', 'd2', 'd3']) writeFileSync(join(corpus, `${id}.pdf`), `%PDF fake ${id}`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bench runner with a fake claude', () => {
  it('runs both arms with identical flags and isolation, grading each answer', async () => {
    setup({ default: [{ kind: 'ok', answer: '5', cost: 0.2 }], 'd2.pdf|distill': [{ kind: 'ok', answer: '8', cost: 0.2, distill: true }] });
    const out = bench([]);
    expect(out.status).toBe(0);
    const recs = records();
    expect(recs).toHaveLength(4);
    expect(recs.every((r) => r.night === '2026-11-19' && r.model === 'sonnet' && r.ok === true && r.attempt === 1)).toBe(true);
    const t1 = recs.filter((r) => r.task === 't1');
    expect(t1.every((r) => r.correct === true && r.answer === '5')).toBe(true);
    const t2 = recs.filter((r) => r.task === 't2');
    expect(t2.find((r) => r.arm === 'baseline')).toMatchObject({ correct: false, answer: '5' });
    expect(t2.find((r) => r.arm === 'distill')).toMatchObject({ correct: false, answer: '8', distillUsed: true, package: 'distill-llm@9.9.9' });
    expect(recs.find((r) => r.arm === 'baseline')).toMatchObject({ package: null, distillUsed: false, numTurns: 3, costUsd: 0.2, usage: { input: 10, output: 20, cacheCreation: 300, cacheRead: 4000 }, toolCalls: { Read: 1 } });

    const c = calls();
    expect(c).toHaveLength(4);
    const strip = (argv: string[]) => argv.filter((a, i) => a !== '--plugin-dir' && argv[i - 1] !== '--plugin-dir').filter((a) => !a.startsWith('Answer this question'));
    const baseline = c.filter((x) => x.key.endsWith('baseline'));
    const distill = c.filter((x) => x.key.endsWith('distill'));
    expect(distill.every((x) => x.argv.includes('--plugin-dir') && x.argv.includes(join(repo, 'plugins', 'distill')))).toBe(true);
    expect(baseline.every((x) => !x.argv.includes('--plugin-dir'))).toBe(true);
    const flags = (x: { argv: string[] }) => strip(x.argv).join(' ');
    expect(new Set([...baseline, ...distill].map(flags)).size).toBe(1);
    expect(flags(baseline[0])).toContain('--model sonnet --output-format stream-json --verbose --max-turns 30 --allowedTools Read,Grep,Glob,Bash --max-budget-usd 2');
    expect(distill.every((x) => x.pluginPackage === 'distill-llm@9.9.9')).toBe(true);
    expect(baseline.every((x) => x.pluginPackage === null)).toBe(true);
    expect(new Set(c.map((x) => x.cacheDir)).size).toBe(4);
    expect(new Set(c.map((x) => x.cwd)).size).toBe(4);
    for (const x of c) {
      expect(x.files).toHaveLength(1);
      expect(x.files[0]).toMatch(/^d[12]\.pdf$/);
      expect(x.argv.find((a: string) => a.startsWith('Answer this question'))).toMatch(/^Answer this question about the file d[12]\.pdf in this folder: What is t[12]\? Finish your reply with one line: ANSWER: <answer>\.$/);
      expect(existsSync(x.cwd)).toBe(false);
    }
  });

  it('retries a failure once and records both attempts', async () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'exit', code: 3 }, { kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    const out = bench(['--arms', 'baseline']);
    expect(out.status).toBe(0);
    const recs = records();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ ok: false, attempt: 1, error: 'exit code 3', correct: null, stderrTail: 'boom' });
    expect(recs[1]).toMatchObject({ ok: true, attempt: 2, correct: true });
  });

  it('records a second failure and moves on to the next run', async () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'exit', code: 1 }] });
    const out = bench(['--arms', 'baseline']);
    expect(out.status).toBe(0);
    const recs = records();
    const t1 = recs.filter((r) => r.task === 't1');
    expect(t1.map((r) => [r.attempt, r.ok])).toEqual([[1, false], [2, false]]);
    expect(recs.find((r) => r.task === 't2')).toMatchObject({ ok: true });
    expect(out.stdout).toContain('failed');
  });

  it('kills a hung run after the timeout and records it', async () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'hang' }] }, [task('t1', 'd1', 5)]);
    const out = bench(['--arms', 'baseline', '--timeout-ms', '400']);
    expect(out.status).toBe(0);
    const recs = records();
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.ok === false && r.timedOut === true && r.error.startsWith('timed out'))).toBe(true);
    for (const c of calls()) {
      expect(() => process.kill(c.pid, 0)).toThrow();
    }
  });

  it('records malformed output and error results as failures', async () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'garbage' }], 'd2.pdf|baseline': [{ kind: 'error' }] });
    const out = bench(['--arms', 'baseline']);
    expect(out.status).toBe(0);
    const recs = records();
    expect(recs.filter((r) => r.task === 't1').every((r) => r.ok === false && r.error === 'no result event in output')).toBe(true);
    expect(recs.filter((r) => r.task === 't2').every((r) => r.ok === false && r.error === 'claude reported error_max_turns')).toBe(true);
  });

  it('records a missing answer as correct: null', async () => {
    setup({ default: [{ kind: 'noanswer' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline']);
    expect(records()[0]).toMatchObject({ ok: true, answer: null, correct: null });
  });

  it('resumes without repeating finished runs', async () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5), task('t2', 'd2', 5), task('t3', 'd1', 5)]);
    expect(bench(['--max-runs', '2']).status).toBe(0);
    expect(records()).toHaveLength(2);
    const second = bench(['--resume']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Resume: 2 of 6 runs already done');
    const recs = records();
    expect(recs).toHaveLength(6);
    const keys = recs.map((r) => `${r.task}|${r.arm}|${r.repeat}`);
    expect(new Set(keys).size).toBe(6);
    const third = bench(['--resume']);
    expect(third.stdout).toContain('Resume: 6 of 6 runs already done');
    expect(records()).toHaveLength(6);
  });

  it('does not treat a first-attempt failure as finished when resuming', async () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'exit' }, { kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, 'runs.jsonl'), `${JSON.stringify({ night: '2026-11-19', task: 't1', arm: 'baseline', repeat: 1, model: 'sonnet', ok: false, attempt: 1, costUsd: 0 })}\n`);
    bench(['--arms', 'baseline', '--resume']);
    expect(records().filter((r) => r.ok === true)).toHaveLength(1);
  });

  it('stops the night when the budget is reached', async () => {
    setup({ default: [{ kind: 'ok', answer: '5', cost: 0.6 }] }, [task('t1', 'd1', 5), task('t2', 'd2', 5), task('t3', 'd1', 5), task('t4', 'd2', 5)]);
    const out = bench(['--arms', 'baseline', '--max-cost-usd', '1']);
    expect(out.status).toBe(0);
    expect(records()).toHaveLength(2);
    expect(out.stdout).toContain('Stopping: spent $1.20');
  });

  it('counts earlier spending from the same night against the budget on resume', async () => {
    setup({ default: [{ kind: 'ok', answer: '5', cost: 0.6 }] }, [task('t1', 'd1', 5), task('t2', 'd2', 5)]);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, 'runs.jsonl'), `${JSON.stringify({ night: '2026-11-19', task: 'old', arm: 'baseline', repeat: 1, model: 'sonnet', ok: true, attempt: 1, costUsd: 5 })}\n`);
    const out = bench(['--arms', 'baseline', '--max-cost-usd', '5', '--resume']);
    expect(out.stdout).toContain('Stopping');
    expect(records()).toHaveLength(1);
  });

  it('honours --max-runs and --tasks filters', async () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5, ['simple']), task('t2', 'd2', 5, ['deep'])]);
    bench(['--tasks', 'tag:deep']);
    expect(records().every((r) => r.task === 't2')).toBe(true);
    expect(records()).toHaveLength(2);
  });

  it('skips tasks whose document is not available', async () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5), task('t9', 'd9', 5)], ['d1', 'd9']);
    const out = bench(['--arms', 'baseline']);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain('document d9 is not available');
    expect(records().map((r) => r.task)).toEqual(['t1']);
  });

  it('refuses to start while another runner holds the lock', async () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] });
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, '.lock'), String(process.pid));
    const out = bench([]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Another benchmark runner');
    expect(existsSync(join(results, 'runs.jsonl'))).toBe(false);
  });

  it('removes its lock when it finishes', async () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline']);
    expect(existsSync(join(results, '.lock'))).toBe(false);
  });

  it('prints the plan with --dry-run without running anything', async () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] });
    const out = bench(['--dry-run']);
    expect(out.stdout).toContain('4 runs planned');
    expect(calls()).toHaveLength(0);
  });
});
