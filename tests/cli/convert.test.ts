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

function fakeDistiller(fail: Set<string> = new Set()) {
  const calls: { path: string; opts: unknown }[] = [];
  const close = vi.fn();
  const distiller: Distiller = {
    async distillFile(path, opts) {
      calls.push({ path, opts });
      const name = basename(path);
      if (fail.has(name)) throw new DistillError('parse_failed', 'broken file');
      return { path, name, kind: 'PDF', pages: 3, markdown: `# ${name}\n`, tokens: { raw: 38900, out: 27100 }, ms: 12 };
    },
    health: () => ({ version: '0.0.0', liteparseVersion: '0.0.0', libreoffice: false, lingua: { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 }, maxBytes: 1 }),
    close,
  };
  return { distiller, calls, close };
}

function harness(fail?: Set<string>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const fake = fakeDistiller(fail);
  const openDistiller = vi.fn(async (_maxBytes?: number) => fake.distiller);
  const deps = {
    openDistiller,
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: { DISTILL_NO_UPDATE_CHECK: '1' },
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
