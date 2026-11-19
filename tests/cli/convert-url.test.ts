import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { DistillError } from '../../src/node/errors';
import type { Distiller, DistillUrlOptions } from '../../src/node/distill';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-convert-url-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const PAGE = '<!-- distill: x -->\n\n# Docs\n\n## One\n\ntext one\n\n## Two\n\ntext two\n';

function harness(markdown = PAGE) {
  const urlCalls: { url: string; opts: DistillUrlOptions | undefined }[] = [];
  const fileCalls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const distiller: Distiller = {
    async distillUrl(url, opts) {
      urlCalls.push({ url, opts });
      if (url.includes('forbidden')) throw new DistillError('forbidden', 'Refused: nope');
      if (!/^https?:/.test(url)) throw new DistillError('bad_request', 'Only http and https URLs are supported');
      return { path: url, name: 'Docs', kind: 'HTML', pages: 1, markdown, tokens: { raw: 50000, out: 2000 }, ms: 9 };
    },
    async distillFile(path) {
      fileCalls.push(path);
      throw new Error('unexpected file read');
    },
    renderPage: async () => {
      throw new Error('unused');
    },
    health: () => ({ version: '0.0.0', liteparseVersion: '0.0.0', libreoffice: false, lingua: { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 }, maxBytes: 1 }),
    close: vi.fn(),
  };
  const deps = {
    openDistiller: vi.fn(async () => distiller),
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: { DISTILL_NO_UPDATE_CHECK: '1', DISTILL_NO_STATS: '1' },
  };
  return { deps, urlCalls, fileCalls, stdout, stderr, exit, distiller };
}

describe('convert with a URL', () => {
  it('prints the Markdown with --stdout and a savings note against the raw page', async () => {
    const h = harness();
    await run(['convert', '--stdout', 'https://docs.example.com/guide/Using_Fetch'], h.deps);
    expect(h.stdout).toEqual([PAGE]);
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toContain('vs the raw page ≈ 50,000 tok');
    expect(h.fileCalls).toEqual([]);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('ignores robots.txt for a single page the user asked for and blocks private addresses by default', async () => {
    const h = harness();
    await run(['convert', '--stdout', 'https://docs.example.com/a'], h.deps);
    expect(h.urlCalls[0]?.opts?.robots).toBe('ignore');
    expect(h.urlCalls[0]?.opts?.allowPrivate).toBeUndefined();
    expect(h.urlCalls[0]?.opts?.allowHosts).toBeUndefined();
  });

  it('passes --allow-private and repeated --allow-host through', async () => {
    const h = harness();
    await run(['convert', '--stdout', '--allow-private', '--allow-host', 'intranet.corp', '--allow-host', 'dev.local', 'http://intranet.corp/a'], h.deps);
    expect(h.urlCalls[0]?.opts).toMatchObject({ allowPrivate: true, allowHosts: ['intranet.corp', 'dev.local'], robots: 'ignore' });
  });

  it('writes <segment>.md into --out and prints the summary', async () => {
    const h = harness();
    await run(['convert', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch', '--out', dir], h.deps);
    expect(readFileSync(join(dir, 'Using_Fetch.md'), 'utf8')).toBe(PAGE);
    expect(h.stdout).toEqual([`https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch → ${join(dir, 'Using_Fetch.md')}  50.0k → 2.0k tokens (−96%)`]);
  });

  it('names a bare host after the host and suffixes collisions', async () => {
    const h = harness();
    await run(['convert', 'https://example.com/', 'https://example.com', 'https://a.example/docs/page.html?x=1', 'https://b.example/page', '--out', dir], h.deps);
    expect(readdirSync(dir).sort()).toEqual(['example.com-2.md', 'example.com.md', 'page-2.md', 'page.md']);
  });

  it('supports --json with the URL as input', async () => {
    const h = harness();
    await run(['convert', 'https://docs.example.com/a', '--out', dir, '--json'], h.deps);
    expect(JSON.parse(h.stdout[0] as string)).toEqual([
      { input: 'https://docs.example.com/a', output: join(dir, 'a.md'), tokens: { raw: 50000, out: 2000 }, pages: 1, ms: 9 },
    ]);
  });

  it('reports a refused URL and exits 1', async () => {
    const h = harness();
    await run(['convert', 'https://forbidden.example/', '--out', dir], h.deps);
    expect(h.stderr).toEqual(['https://forbidden.example/  error: forbidden: Refused: nope']);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('sends non-http schemes to the URL path instead of reading a file', async () => {
    const h = harness();
    await run(['convert', '--stdout', 'file:///etc/passwd'], h.deps);
    expect(h.fileCalls).toEqual([]);
    expect(h.stderr[0]).toContain('bad_request: Only http and https URLs are supported');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('pages a long page with --max-tokens and names the URL in the hint', async () => {
    const long = `# Big\n\n${Array.from({ length: 400 }, (_, i) => `## Part ${i}\n\nSome text in part ${i} of the page.\n`).join('\n')}`;
    const h = harness(long);
    await run(['convert', '--stdout', '--max-tokens', '300', 'https://docs.example.com/big'], h.deps);
    const out = h.stdout[0] as string;
    expect(out).toContain('Showing lines 1-');
    expect(out).toContain('"https://docs.example.com/big"');
  });

  it('slices with --offset and --limit', async () => {
    const h = harness('a\nb\nc\nd\n');
    await run(['convert', '--stdout', '--offset', '2', '--limit', '2', 'https://docs.example.com/x'], h.deps);
    expect(h.stdout[0]).toBe('b\nc');
  });
});

describe('outline with a URL', () => {
  it('indexes a web page', async () => {
    const h = harness();
    await run(['outline', 'https://docs.example.com/a'], h.deps);
    expect(h.stdout[0]).toContain('Docs');
    expect(h.stdout[0]).toContain('One');
    expect(h.stdout[0]).toContain('Two');
    expect(h.urlCalls[0]?.opts?.robots).toBe('ignore');
  });

  it('passes the address overrides', async () => {
    const h = harness();
    await run(['outline', '--allow-private', 'http://localhost:3000/'], h.deps);
    expect(h.urlCalls[0]?.opts?.allowPrivate).toBe(true);
  });
});
