import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { DistillError } from '../../src/node/errors';
import type { Distiller, DistillUrlOptions } from '../../src/node/distill';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-grep-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const DOC = ['# Report', '<!-- page 1 -->', 'Intro text.', '## Costs', '<!-- page 2 -->', 'The total cost was 4,200', '000 euros.', 'Nothing else.'].join('\n');

function harness(env: Record<string, string> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const urlCalls: { url: string; opts: DistillUrlOptions | undefined }[] = [];
  const fileCalls: { path: string; opts: DistillUrlOptions | undefined }[] = [];
  const close = vi.fn();
  const distiller: Distiller = {
    async distillFile(path, opts) {
      fileCalls.push({ path, opts });
      if (path.endsWith('bad.pdf')) throw new DistillError('parse_failed', 'broken file');
      return { path, name: 'doc.pdf', kind: 'PDF', pages: 2, markdown: DOC, tokens: { raw: 5000, out: 3000 }, ms: 3 };
    },
    async distillUrl(url, opts) {
      urlCalls.push({ url, opts });
      return { path: url, name: 'Page', kind: 'HTML', pages: 1, markdown: DOC, tokens: { raw: 5000, out: 3000 }, ms: 3 };
    },
    renderPage: async () => {
      throw new Error('unused');
    },
    health: () => ({ version: '0.0.0', liteparseVersion: '0.0.0', libreoffice: false, lingua: { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 }, maxBytes: 1 }),
    close,
  };
  const deps = {
    openDistiller: vi.fn(async () => distiller),
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: { DISTILL_NO_UPDATE_CHECK: '1', DISTILL_NO_STATS: '1', ...env },
  };
  return { deps, stdout, stderr, exit, urlCalls, fileCalls, close };
}

function pdf(name = 'doc.pdf'): string {
  const path = join(dir, name);
  writeFileSync(path, 'x');
  return path;
}

describe('grep', () => {
  it('prints each hit as p.<page> L<line>: text', async () => {
    const h = harness();
    await run(['grep', '4,200 000', pdf(), '--context', '0'], h.deps);
    expect(h.stdout).toEqual(['p.2 L6: The total cost was 4,200\n  000 euros.']);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('prints the savings note on stderr unless disabled', async () => {
    const h = harness();
    await run(['grep', 'intro', pdf()], h.deps);
    expect(h.stderr[0]).toContain('[distill] tokens saved');
    expect(h.stderr[0]).toContain('reading the whole document');
    const quiet = harness({ DISTILL_NO_SAVINGS_NOTE: '1' });
    await run(['grep', 'intro', pdf()], quiet.deps);
    expect(quiet.stderr).toEqual([]);
  });

  it('prints JSON with --json', async () => {
    const h = harness();
    await run(['grep', 'cost', pdf(), '--json', '--context', '0'], h.deps);
    expect(h.stdout).toHaveLength(1);
    const json = JSON.parse(h.stdout[0]);
    expect(json.total).toBe(2);
    expect(json.truncated).toBe(false);
    expect(json.hits[0]).toMatchObject({ line: 4, page: 1, section: 'Costs', text: '## Costs' });
    expect(h.stderr).toEqual([]);
  });

  it('honours --max and says how many were left out', async () => {
    const h = harness();
    await run(['grep', 'o', pdf(), '--context', '0', '--max', '1'], h.deps);
    expect(h.stdout.join('\n')).toContain('more not shown');
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('supports --regex', async () => {
    const h = harness();
    await run(['grep', 'cost was [\\d,]+', pdf(), '--regex', '--context', '0'], h.deps);
    expect(h.stdout[0]).toContain('p.2 L6:');
  });

  it('rejects a bad regex with exit 2 and no conversion', async () => {
    const h = harness();
    await run(['grep', '(', pdf(), '--regex'], h.deps);
    expect(h.stderr[0]).toMatch(/invalid regex/i);
    expect(h.exit).toHaveBeenCalledWith(2);
  });

  it('prints No matches and exits 0 when nothing is found', async () => {
    const h = harness();
    await run(['grep', 'zebra', pdf()], h.deps);
    expect(h.stdout).toEqual(['No matches.']);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('searches a web page and passes the address overrides', async () => {
    const h = harness();
    await run(['grep', 'intro', 'http://localhost:8080/a', '--allow-private'], h.deps);
    expect(h.urlCalls[0]?.opts?.robots).toBe('ignore');
    expect(h.urlCalls[0]?.opts?.allowPrivate).toBe(true);
    expect(h.stdout[0]).toContain('L3:');
  });

  it('reports a conversion failure on stderr and exits 1', async () => {
    const h = harness();
    await run(['grep', 'x', pdf('bad.pdf')], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.stderr[0]).toContain('parse_failed');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it.each(['-1', 'abc', '1.5'])('rejects an invalid --context %s', async (value) => {
    const h = harness();
    await run(['grep', 'x', pdf(), '--context', value], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.deps.openDistiller).not.toHaveBeenCalled();
  });
});

describe('grep speech model options', () => {
  it('passes --asr-model and --language to the distiller', async () => {
    const h = harness();
    await run(['grep', 'intro', pdf(), '--asr-model', 'whisper-turbo', '--language', 'es'], h.deps);
    expect(h.fileCalls[0].opts).toMatchObject({ asrModel: 'whisper-turbo', language: 'es', lingua: false });
  });

  it('rejects an unknown model', async () => {
    const h = harness();
    await run(['grep', 'intro', pdf(), '--asr-model', 'nope'], h.deps);
    expect(h.exit).toHaveBeenCalledWith(2);
  });
});
