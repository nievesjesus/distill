import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';

function setup(options: { isTTY?: boolean; answer?: string; which?: string | null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'distill-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'distill-cwd-'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const prompt = vi.fn(async () => options.answer ?? 'n');
  const deps = {
    homeDir: home,
    cwd,
    which: () => (options.which === undefined ? '/usr/bin/distillmd' : options.which),
    isTTY: options.isTTY ?? false,
    prompt,
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: {},
  };
  return { home, cwd, stdout, stderr, exit, prompt, deps };
}

describe('hooks install --claude', () => {
  it('refuses without a TTY and without --yes', async () => {
    const s = setup();
    await run(['hooks', 'install', '--claude'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr).toContain('Refusing to write without confirmation. Re-run with --yes.');
    expect(existsSync(join(s.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('writes with --yes and prints a diff', async () => {
    const s = setup();
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    expect(s.exit).not.toHaveBeenCalled();
    const text = readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8');
    expect(JSON.parse(text).hooks.PreToolUse[0].hooks[0].command).toBe('distillmd hook claude');
    expect(s.stdout.some((line) => line.startsWith('+'))).toBe(true);
    expect(s.stdout.join('\n')).toContain(join(s.home, '.claude', 'settings.json'));
  });

  it('asks on a TTY and writes on y', async () => {
    const s = setup({ isTTY: true, answer: 'y' });
    await run(['hooks', 'install', '--claude'], s.deps);
    expect(s.prompt).toHaveBeenCalledWith('Apply? [y/N] ');
    expect(existsSync(join(s.home, '.claude', 'settings.json'))).toBe(true);
  });

  it('does not write on n', async () => {
    const s = setup({ isTTY: true, answer: 'n' });
    await run(['hooks', 'install', '--claude'], s.deps);
    expect(existsSync(join(s.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('writes to the cwd with --project', async () => {
    const s = setup();
    await run(['hooks', 'install', '--claude', '--project', '--yes'], s.deps);
    expect(existsSync(join(s.cwd, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(s.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('falls back to npx with a tip', async () => {
    const s = setup({ which: null });
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    const text = readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8');
    expect(JSON.parse(text).hooks.PreToolUse[0].hooks[0].command).toMatch(/^npx -y distillmd@\S+ hook claude$/);
    expect(s.stdout).toContain('Tip: npm i -g distillmd makes the hook start faster.');
  });

  it('aborts on invalid JSON without touching the file', async () => {
    const s = setup();
    const file = join(s.home, '.claude', 'settings.json');
    mkdirSync(join(s.home, '.claude'), { recursive: true });
    writeFileSync(file, '{ nope');
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr[0]).toMatch(/^Could not parse .*settings\.json: .+\. Nothing was changed\.$/);
    expect(readFileSync(file, 'utf8')).toBe('{ nope');
  });

  it('does nothing when already installed', async () => {
    const s = setup();
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    const file = join(s.home, '.claude', 'settings.json');
    const before = readFileSync(file, 'utf8');
    const again = setup();
    again.deps.homeDir = s.home;
    await run(['hooks', 'install', '--claude', '--yes'], again.deps);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(again.stdout.join('\n')).toContain('Already installed');
  });

  it('requires a target', async () => {
    const s = setup();
    await run(['hooks', 'install', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
  });
});

describe('hooks uninstall --claude', () => {
  it('removes the entries', async () => {
    const s = setup();
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    await run(['hooks', 'uninstall', '--claude', '--yes'], s.deps);
    const file = join(s.home, '.claude', 'settings.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('prints Nothing to remove. when the file is missing', async () => {
    const s = setup();
    await run(['hooks', 'uninstall', '--claude', '--yes'], s.deps);
    expect(s.stdout).toContain('Nothing to remove.');
    expect(s.exit).not.toHaveBeenCalled();
  });
});

describe('hooks --opencode', () => {
  it('installs and uninstalls the plugin', async () => {
    const s = setup();
    const file = join(s.home, '.config', 'opencode', 'plugins', 'distill.js');
    await run(['hooks', 'install', '--opencode', '--yes'], s.deps);
    expect(readFileSync(file, 'utf8')).toContain('DistillPlugin');
    await run(['hooks', 'uninstall', '--opencode', '--yes'], s.deps);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses without confirmation', async () => {
    const s = setup();
    await run(['hooks', 'install', '--opencode'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(existsSync(join(s.home, '.config', 'opencode', 'plugins', 'distill.js'))).toBe(false);
  });

  it('writes to the cwd with --project', async () => {
    const s = setup();
    await run(['hooks', 'install', '--opencode', '--project', '--yes'], s.deps);
    expect(existsSync(join(s.cwd, '.opencode', 'plugins', 'distill.js'))).toBe(true);
  });

  it('prints Nothing to remove. when absent', async () => {
    const s = setup();
    await run(['hooks', 'uninstall', '--opencode', '--yes'], s.deps);
    expect(s.stdout).toContain('Nothing to remove.');
  });
});

describe('hooks install robustness', () => {
  it('writes through a symlinked settings.json and keeps the link', async () => {
    const s = setup();
    const real = join(s.home, 'dotfiles', 'settings.json');
    mkdirSync(join(s.home, 'dotfiles'), { recursive: true });
    mkdirSync(join(s.home, '.claude'), { recursive: true });
    writeFileSync(real, '{}\n');
    const link = join(s.home, '.claude', 'settings.json');
    symlinkSync(real, link);
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.PreToolUse).toHaveLength(1);
  });

  it('keeps the file mode', async () => {
    const s = setup();
    const file = join(s.home, '.claude', 'settings.json');
    mkdirSync(join(s.home, '.claude'), { recursive: true });
    writeFileSync(file, '{}\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never prints unrelated secrets and notes re-indentation', async () => {
    const s = setup();
    const file = join(s.home, '.claude', 'settings.json');
    mkdirSync(join(s.home, '.claude'), { recursive: true });
    const others = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    writeFileSync(file, JSON.stringify({ env: { SECRET: 'hunter2' }, ...others }));
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    const out = s.stdout.join('\n');
    expect(out).not.toContain('hunter2');
    expect(out).toContain(`Note: ${file} will be re-indented with 2 spaces.`);
    expect(out).toContain('…');
  });

  it('leaves a foreign distill.js alone on uninstall and refuses to overwrite it', async () => {
    const s = setup();
    const file = join(s.home, '.config', 'opencode', 'plugins', 'distill.js');
    mkdirSync(join(s.home, '.config', 'opencode', 'plugins'), { recursive: true });
    writeFileSync(file, 'export const Mine = 1;\n');
    await run(['hooks', 'uninstall', '--opencode', '--yes'], s.deps);
    expect(s.stdout).toContain(`${file} was not created by distill; leaving it.`);
    expect(s.exit).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
    await run(['hooks', 'install', '--opencode', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(readFileSync(file, 'utf8')).toBe('export const Mine = 1;\n');
  });

  it('upgrades a pinned entry', async () => {
    const s = setup({ which: null });
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    const again = setup();
    again.deps.homeDir = s.home;
    await run(['hooks', 'install', '--claude', '--yes'], again.deps);
    const text = readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8');
    expect(JSON.parse(text).hooks.PreToolUse[0].hooks[0].command).toBe('distillmd hook claude');
  });

  it('reports read errors on one line', async () => {
    const s = setup();
    mkdirSync(join(s.home, '.claude', 'settings.json'), { recursive: true });
    await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr).toHaveLength(1);
    expect(s.stderr[0]).toMatch(/^Could not read .*settings\.json: /);
  });

  it('reports write errors on one line', async () => {
    const s = setup();
    const dir = join(s.home, '.claude');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      await run(['hooks', 'install', '--claude', '--yes'], s.deps);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr).toHaveLength(1);
    expect(s.stderr[0]).toMatch(/^Could not write .*settings\.json: /);
  });
});
