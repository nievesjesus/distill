import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = () => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', 'launchd.mjs')).href);
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

describe('nightly.sh', () => {
  const script = read('bench/nightly.sh');

  it('is valid bash and executable', () => {
    expect(spawnSync('bash', ['-n', join(repo, 'bench', 'nightly.sh')]).status).toBe(0);
    expect(statSync(join(repo, 'bench', 'nightly.sh')).mode & 0o111).not.toBe(0);
  });

  it('fetches, runs with resume and the budget, then reports, logging per date', () => {
    expect(script).toContain('node bench/fetch.mjs');
    expect(script).toContain('node bench/run.mjs --resume --scenario both --max-cost-usd "${DISTILL_BENCH_BUDGET:-15}"');
    expect(script).not.toContain('--tasks');
    expect(script).toContain('node bench/report.mjs');
    expect(script).toContain('logs');
    expect(script).toContain('$(date +%F).log');
    expect(script.indexOf('bench/fetch.mjs')).toBeLessThan(script.indexOf('bench/run.mjs'));
    expect(script.indexOf('bench/run.mjs')).toBeLessThan(script.indexOf('bench/report.mjs'));
  });
});

describe('launchd plist', () => {
  it('renders every placeholder with escaped values', async () => {
    const { renderPlist, escapeXml } = await load();
    expect(escapeXml('a&b<c>"d\'')).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    const xml = renderPlist(read('bench/launchd/dev.distill.bench.plist.template'), { SCRIPT: '/r/a&b/nightly.sh', ROOT: '/r/a&b', HOME: '/Users/x', LOG_DIR: '/Users/x/logs' });
    expect(xml).not.toMatch(/\{\{/);
    expect(xml).toContain('/r/a&amp;b/nightly.sh');
    expect(xml).toContain('<key>Label</key>\n  <string>dev.distill.bench</string>');
  });

  it('schedules 02:30 with RunAtLoad off and lints as a plist', async () => {
    const { plistFor, launchdPaths } = await load();
    const xml = plistFor(launchdPaths());
    expect(xml).toMatch(/<key>Hour<\/key>\s*<integer>2<\/integer>/);
    expect(xml).toMatch(/<key>Minute<\/key>\s*<integer>30<\/integer>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    const dir = mkdtempSync(join(tmpdir(), 'distill-bench-plist-'));
    try {
      const file = join(dir, 'x.plist');
      writeFileSync(file, xml);
      const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      if (!lint.error) expect(lint.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a template with an unknown placeholder', async () => {
    const { renderPlist } = await load();
    expect(() => renderPlist('{{NOPE}}', {})).toThrow('Missing plist value NOPE');
  });
});

describe('install and uninstall scripts', () => {
  const run = (file: string, args: string[]) => spawnSync(process.execPath, [join(repo, 'bench', file), ...args], { encoding: 'utf8', input: '' });

  it.each(['install-nightly.mjs', 'uninstall-nightly.mjs'])('%s dry run changes nothing and says what it would do', (file) => {
    const out = run(file, ['--dry-run']);
    if (process.platform !== 'darwin') {
      expect(out.status).toBe(1);
      return;
    }
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('This will:');
    expect(out.stdout).toContain('Dry run: nothing was changed.');
    expect(out.stdout).toContain('dev.distill.bench.plist');
  });

  it.each(['install-nightly.mjs', 'uninstall-nightly.mjs'])('%s cancels without a terminal or --yes', (file) => {
    if (process.platform !== 'darwin') return;
    const out = run(file, []);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Cancelled, nothing was changed.');
  });
});

describe('package.json scripts', () => {
  const pkg = JSON.parse(read('package.json'));

  it('defines the bench scripts and ships nothing from bench', () => {
    for (const name of ['bench', 'bench:fetch', 'bench:report', 'bench:install-nightly', 'bench:uninstall-nightly']) expect(pkg.scripts[name]).toContain('bench/');
    expect(pkg.files.some((f: string) => f.startsWith('bench'))).toBe(false);
  });
});
