import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { DistillError } from '../../src/node/errors';
import type { Distiller } from '../../src/node/distill';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-convert-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeDistiller(fail: Set<string> = new Set(), markdown?: string) {
  const calls: { path: string; opts: unknown }[] = [];
  const close = vi.fn();
  const distiller: Distiller = {
    distillUrl: async () => { throw new Error('unused'); },
    renderPage: async () => { throw new Error('unused'); },
    async distillFile(path, opts) {
      calls.push({ path, opts });
      const name = basename(path);
      if (fail.has(name)) throw new DistillError('parse_failed', 'broken file');
      return { path, name, kind: 'PDF', pages: 3, markdown: markdown ?? `# ${name}\n`, tokens: { raw: 38900, out: 27100 }, ms: 12 };
    },
    health: () => ({ version: '0.0.0', liteparseVersion: '0.0.0', libreoffice: false, lingua: { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 }, maxBytes: 1 }),
    close,
  };
  return { distiller, calls, close };
}

function harness(fail?: Set<string>, markdown?: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const fake = fakeDistiller(fail, markdown);
  const openDistiller = vi.fn(async (_maxBytes?: number) => fake.distiller);
  const deps = {
    openDistiller,
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: { DISTILL_NO_UPDATE_CHECK: '1', DISTILL_NO_STATS: '1' },
  };
  return { deps, stdout, stderr, exit, openDistiller, ...fake };
}

function touch(...names: string[]): string[] {
  return names.map((name) => {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'x');
    return path;
  });
}

describe('convert', () => {
  it('writes <base>.md next to the input and prints the summary', async () => {
    const h = harness();
    const [pdf] = touch('report.pdf');
    await run(['convert', pdf], h.deps);
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('# report.pdf\n');
    expect(h.stdout).toEqual([`${pdf} → ${join(dir, 'report.md')}  38.9k → 27.1k tokens (−30%)`]);
    expect(h.stderr).toEqual([]);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('writes into --out, creating it', async () => {
    const h = harness();
    const [pdf] = touch('report.pdf');
    const out = join(dir, 'nested', 'out');
    await run(['convert', pdf, '--out', out], h.deps);
    expect(existsSync(join(out, 'report.md'))).toBe(true);
    expect(existsSync(join(dir, 'report.md'))).toBe(false);
  });

  it('suffixes colliding destinations within one run and overwrites old files', async () => {
    const h = harness();
    const [a, b, c] = touch('a/report.pdf', 'b/report.docx', 'c/report.pptx');
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'report.md'), 'stale');
    await run(['convert', a, b, c, '--out', out], h.deps);
    expect(readdirSync(out).sort()).toEqual(['report-2.md', 'report-3.md', 'report.md']);
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toBe('# report.pdf\n');
  });

  it('prints a single JSON array and nothing else with --json', async () => {
    const h = harness(new Set(['bad.pdf']));
    const [good, bad] = touch('good.pdf', 'bad.pdf');
    await run(['convert', good, bad, '--json'], h.deps);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0])).toEqual([
      { input: good, output: join(dir, 'good.md'), tokens: { raw: 38900, out: 27100 }, pages: 3, ms: 12 },
      { input: bad, error: { code: 'parse_failed', message: 'broken file' } },
    ]);
    expect(h.stderr).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('keeps going after a failure and exits 1', async () => {
    const h = harness(new Set(['bad.pdf']));
    const [bad, good] = touch('bad.pdf', 'good.pdf');
    await run(['convert', bad, good], h.deps);
    expect(h.stderr).toEqual([`${bad}  error: parse_failed: broken file`]);
    expect(existsSync(join(dir, 'good.md'))).toBe(true);
    expect(existsSync(join(dir, 'bad.md'))).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('prints markdown and writes nothing with --stdout', async () => {
    const h = harness();
    const [pdf] = touch('report.pdf');
    await run(['convert', pdf, '--stdout'], h.deps);
    expect(h.stdout).toEqual(['# report.pdf\n']);
    expect(existsSync(join(dir, 'report.md'))).toBe(false);
  });

  it('prints the savings note on stderr with --stdout', async () => {
    const h = harness();
    const [pdf] = touch('report.pdf');
    await run(['convert', pdf, '--stdout'], h.deps);
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toMatch(/^\[distill\] tokens saved ≈ /);
    expect(h.stdout).toEqual(['# report.pdf\n']);
  });

  it('omits the savings note with DISTILL_NO_SAVINGS_NOTE=1', async () => {
    const h = harness();
    const [pdf] = touch('report.pdf');
    await run(['convert', pdf, '--stdout'], { ...h.deps, env: { ...h.deps.env, DISTILL_NO_SAVINGS_NOTE: '1' } });
    expect(h.stderr).toEqual([]);
  });

  it('prints no savings note without --stdout', async () => {
    const h = harness();
    const [pdf] = touch('report.pdf');
    await run(['convert', pdf], h.deps);
    expect(h.stderr).toEqual([]);
  });

  it('rejects --stdout with several files', async () => {
    const h = harness();
    const [a, b] = touch('a.pdf', 'b.pdf');
    await run(['convert', a, b, '--stdout'], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr[0]).toContain('--stdout');
    expect(h.openDistiller).not.toHaveBeenCalled();
  });

  it('rejects --boosters with --no-optimize', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--boosters', 'ws', '--no-optimize'], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr[0]).toContain('--boosters');
    expect(h.openDistiller).not.toHaveBeenCalled();
  });

  it('shows the booster list message for an unknown booster', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--boosters', 'foo'], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr[0]).toContain('Unknown booster: foo. Valid: dedupe, media, tables, ws');
  });

  it('passes options through to the distiller', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--boosters', 'ws,dedupe', '--lingua', '--rate', '0.3', '--max-size', '5'], h.deps);
    expect(h.openDistiller).toHaveBeenCalledWith(5242880);
    expect(h.calls[0].opts).toEqual({ boosters: new Set(['ws', 'dedupe']), lingua: true, rate: 0.3 });
  });

  it('uses an empty booster set with --no-optimize', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--no-optimize'], h.deps);
    expect(h.calls[0].opts).toEqual({ boosters: new Set(), lingua: false, rate: undefined });
  });

  it('rejects a rate outside 0..1', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--rate', '2'], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
  });

  it('converts at most 4 files at once', async () => {
    const h = harness();
    let active = 0;
    let peak = 0;
    h.distiller.distillFile = async (path) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { path, name: 'x', kind: 'PDF', pages: 1, markdown: 'm', tokens: { raw: 1, out: 1 }, ms: 1 };
    };
    const files = touch(...Array.from({ length: 9 }, (_, i) => `f${i}.pdf`));
    await run(['convert', ...files, '--json'], h.deps);
    expect(peak).toBe(4);
  });

  it('reports an openDistiller failure on stderr and exits 1', async () => {
    const h = harness();
    h.openDistiller.mockRejectedValueOnce(new Error('no parser'));
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf], h.deps);
    expect(h.stderr).toEqual(['error: no parser']);
    expect(h.stdout).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('reports an openDistiller failure as JSON entries with --json', async () => {
    const h = harness();
    h.openDistiller.mockRejectedValueOnce(new Error('no parser'));
    const [a, b] = touch('a.pdf', 'b.pdf');
    await run(['convert', a, b, '--json'], h.deps);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0])).toEqual([
      { input: a, error: { code: 'internal', message: 'no parser' } },
      { input: b, error: { code: 'internal', message: 'no parser' } },
    ]);
    expect(h.stderr).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('detects destination collisions case-insensitively', async () => {
    const h = harness();
    const [a, b] = touch('Report.pdf', 'report.docx');
    await run(['convert', a, b, '--out', join(dir, 'out')], h.deps);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['Report.md', 'report-2.md']);
  });
});

const LARGE = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? `# Section ${i / 10}` : `Line ${i} with some words in it`)).join('\n');

describe('convert --offset, --limit and --max-tokens', () => {
  it('prints a slice with --offset and --limit', async () => {
    const h = harness(undefined, LARGE);
    const [pdf] = touch('big.pdf');
    await run(['convert', pdf, '--stdout', '--offset', '2', '--limit', '3'], h.deps);
    expect(h.stdout).toEqual([LARGE.split('\n').slice(1, 4).join('\n')]);
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toContain('tokens saved');
  });

  it('prints from --offset to the end without --limit', async () => {
    const h = harness(undefined, LARGE);
    const [pdf] = touch('big.pdf');
    await run(['convert', pdf, '--stdout', '--offset', '39'], h.deps);
    expect(h.stdout).toEqual([LARGE.split('\n').slice(38).join('\n')]);
  });

  it('prints the index, the first lines and a hint with --max-tokens on a large document', async () => {
    const h = harness(undefined, LARGE);
    const [pdf] = touch('big.pdf');
    await run(['convert', pdf, '--stdout', '--max-tokens', '60'], h.deps);
    expect(h.stdout).toHaveLength(1);
    const out = h.stdout[0];
    expect(out.startsWith('Index of big.pdf: 40 lines')).toBe(true);
    expect(out).toContain('L1-10 ·');
    expect(out).toContain('# Section 0');
    expect(out).toMatch(/\n\n# Section 0\nLine 1/);
    expect(out).toMatch(/\n\[distill\] Showing lines 1-\d+ of 40\. Read more with: distill-llm convert --stdout --offset <line> --limit <lines> "[^"]*big\.pdf"$/);
    expect(h.stderr.filter((line) => line.includes('tokens saved'))).toHaveLength(1);
  });

  it('prints small documents unchanged under --max-tokens', async () => {
    const h = harness(undefined, LARGE);
    const [pdf] = touch('big.pdf');
    await run(['convert', pdf, '--stdout', '--max-tokens', '50000'], h.deps);
    expect(h.stdout).toEqual([LARGE]);
  });

  it.each([
    [['--offset', '2']],
    [['--limit', '2']],
    [['--max-tokens', '100']],
  ])('requires --stdout for %j', async (extra) => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, ...extra], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr[0]).toContain('--stdout');
    expect(h.openDistiller).not.toHaveBeenCalled();
  });

  it('rejects --max-tokens with --offset', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--stdout', '--max-tokens', '100', '--offset', '2'], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr[0]).toContain('--max-tokens');
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects an invalid --offset %s', async (value) => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['convert', pdf, '--stdout', '--offset', value], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.openDistiller).not.toHaveBeenCalled();
  });
});

describe('convert audio and video options', () => {
  it('passes --timestamps and --frames to the distiller', async () => {
    const h = harness();
    const [video] = touch('talk.mp4');
    await run(['convert', video, '--stdout', '--timestamps', 'segment', '--frames', 'none'], h.deps);
    expect(h.calls[0].opts).toMatchObject({ timestamps: 'segment', frames: 'none' });
  });

  it('leaves both unset by default so the engine picks coarse and ocr', async () => {
    const h = harness();
    const [video] = touch('talk.mp4');
    await run(['convert', video, '--stdout'], h.deps);
    expect(h.calls[0].opts).not.toHaveProperty('timestamps');
    expect(h.calls[0].opts).not.toHaveProperty('frames');
  });

  it.each([['--timestamps', 'fine'], ['--frames', 'all']])('rejects %s %s', async (flag, value) => {
    const h = harness();
    const [video] = touch('talk.mp4');
    await run(['convert', video, '--stdout', flag, value], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.openDistiller).not.toHaveBeenCalled();
  });
});

describe('outline', () => {
  it('prints the rendered index with the file name', async () => {
    const h = harness(undefined, LARGE);
    const [pdf] = touch('big.pdf');
    await run(['outline', pdf], h.deps);
    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0].startsWith('Index of big.pdf: 40 lines')).toBe(true);
    expect(h.stdout[0]).toContain('# Section 3');
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('prints JSON with --json', async () => {
    const h = harness(undefined, LARGE);
    const [pdf] = touch('big.pdf');
    await run(['outline', pdf, '--json'], h.deps);
    expect(h.stdout).toHaveLength(1);
    const json = JSON.parse(h.stdout[0]);
    expect(Object.keys(json)).toEqual(['kind', 'pages', 'lines', 'tokens', 'entries']);
    expect(json).toMatchObject({ kind: 'PDF', pages: 3, lines: 40 });
    expect(json.entries).toHaveLength(4);
    expect(json.entries[0]).toMatchObject({ kind: 'heading', line: 1, endLine: 10 });
  });

  it('reports a failure on stderr and exits 1', async () => {
    const h = harness(new Set(['bad.pdf']));
    const [pdf] = touch('bad.pdf');
    await run(['outline', pdf], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.stderr[0]).toContain('parse_failed');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('uses the default boosters', async () => {
    const h = harness();
    const [pdf] = touch('a.pdf');
    await run(['outline', pdf], h.deps);
    expect(h.calls[0].opts).toMatchObject({ lingua: false });
    expect((h.calls[0].opts as { boosters?: unknown }).boosters).toBeUndefined();
  });
});
