import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { isOwnSkill } from '../../src/hooks/claude-skill';

interface Options {
  bins?: string[];
  global?: boolean;
  isTTY?: boolean;
  answer?: string;
  execStatus?: number;
  platform?: NodeJS.Platform;
}

function setup(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'distill-agents-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'distill-agents-cwd-'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[][] = [];
  const exit = vi.fn();
  const bins = options.bins ?? [];
  const global = options.global ?? true;
  const deps = {
    homeDir: home,
    cwd,
    which: (bin: string) => (bin === 'distill-llm' ? (global ? '/usr/bin/distill-llm' : null) : bins.includes(bin) ? `/usr/bin/${bin}` : null),
    isTTY: options.isTTY ?? false,
    prompt: vi.fn(async () => options.answer ?? 'n'),
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: {} as Record<string, string>,
    platform: options.platform ?? ('darwin' as NodeJS.Platform),
    exec: (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      if (bin === 'opencode') return { status: 0, stdout: '1.2.27\n', stderr: '' };
      return { status: options.execStatus ?? 0, stdout: '', stderr: options.execStatus ? 'boom' : '' };
    },
  };
  return { home, cwd, stdout, stderr, calls, exit, deps };
}

const text = (lines: string[]) => lines.join('\n');
const put = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

describe('agents install', () => {
  it('asks for an agent', async () => {
    const s = setup();
    await run(['agents', 'install'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(2);
    expect(s.stderr[0]).toMatch(/Choose an agent/);
  });

  it('refuses without a TTY and without --yes, changing nothing', async () => {
    const s = setup();
    await run(['agents', 'install', '--cursor'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr.join('\n')).toContain('Re-run with --yes');
    expect(existsSync(join(s.home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('writes the cursor config and the shared skill with --yes', async () => {
    const s = setup();
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    const config = JSON.parse(readFileSync(join(s.home, '.cursor', 'mcp.json'), 'utf8'));
    expect(config.mcpServers.distill).toEqual({ type: 'stdio', command: 'distill-llm', args: ['mcp'] });
    const skill = readFileSync(join(s.home, '.agents', 'skills', 'distill-documents', 'SKILL.md'), 'utf8');
    expect(isOwnSkill(skill)).toBe(true);
    expect(skill).toContain('distill-llm convert --stdout');
    expect(text(s.stdout)).toContain('cursor://anysphere.cursor-deeplink/mcp/install?name=distill&config=');
    expect(s.exit).not.toHaveBeenCalled();
  });

  it('prompts on a TTY and aborts on no', async () => {
    const s = setup({ isTTY: true, answer: 'n' });
    await run(['agents', 'install', '--cursor'], s.deps);
    expect(text(s.stdout)).toContain('Aborted.');
    expect(existsSync(join(s.home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('dry-run prints the changes and writes nothing', async () => {
    const s = setup({ bins: ['codex'] });
    await run(['agents', 'install', '--cursor', '--codex', '--dry-run'], s.deps);
    expect(text(s.stdout)).toContain('"mcpServers"');
    expect(text(s.stdout)).toContain('Command: codex mcp add distill -- distill-llm mcp');
    expect(s.calls).toEqual([]);
    expect(existsSync(join(s.home, '.cursor'))).toBe(false);
    expect(existsSync(join(s.home, '.agents'))).toBe(false);
    expect(s.exit).not.toHaveBeenCalled();
  });

  it('refuses a non-global command, but only warns on dry-run', async () => {
    const refused = setup({ global: false });
    await run(['agents', 'install', '--cursor', '--yes'], refused.deps);
    expect(refused.exit).toHaveBeenCalledWith(1);
    expect(refused.stderr.join('\n')).toContain('npm i -g distill-llm');
    expect(existsSync(join(refused.home, '.cursor'))).toBe(false);
    const dry = setup({ global: false });
    await run(['agents', 'install', '--cursor', '--dry-run'], dry.deps);
    expect(dry.exit).not.toHaveBeenCalled();
    expect(text(dry.stdout)).toMatch(/Warning: distill-llm is not installed globally/);
  });

  it('runs codex through its CLI and prints the TOML follow-up', async () => {
    const s = setup({ bins: ['codex'] });
    await run(['agents', 'install', '--codex', '--yes'], s.deps);
    expect(s.calls).toEqual([['codex', 'mcp', 'add', 'distill', '--', 'distill-llm', 'mcp']]);
    expect(text(s.stdout)).toContain('startup_timeout_sec = 60');
    expect(isOwnSkill(readFileSync(join(s.home, '.agents', 'skills', 'distill-documents', 'SKILL.md'), 'utf8'))).toBe(true);
  });

  it('stops with exit 1 when the agent CLI fails', async () => {
    const s = setup({ bins: ['codex'], execStatus: 3 });
    await run(['agents', 'install', '--codex', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr.join('\n')).toContain('codex mcp add distill -- distill-llm mcp failed: boom');
  });

  it('installs the hermes skill under ~/.hermes', async () => {
    const s = setup({ bins: ['hermes'] });
    await run(['agents', 'install', '--hermes', '--yes'], s.deps);
    expect(s.calls[0]).toEqual(['hermes', 'mcp', 'add', 'distill', '--command', 'distill-llm', '--args', 'mcp']);
    expect(existsSync(join(s.home, '.hermes', 'skills', 'distill-documents', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(s.home, '.agents', 'skills'))).toBe(false);
  });

  it('opencode on V1 writes the config, the plugin and the skill', async () => {
    const s = setup({ bins: ['opencode'] });
    await run(['agents', 'install', '--opencode', '--yes'], s.deps);
    const config = JSON.parse(readFileSync(join(s.home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.distill.type).toBe('local');
    expect(existsSync(join(s.home, '.config', 'opencode', 'plugins', 'distill.js'))).toBe(true);
    expect(existsSync(join(s.home, '.agents', 'skills', 'distill-documents', 'SKILL.md'))).toBe(true);
  });

  it('claude-desktop writes its config and says to restart', async () => {
    const s = setup();
    await run(['agents', 'install', '--claude-desktop', '--yes'], s.deps);
    const path = join(s.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.distill).toEqual({ command: 'distill-llm', args: ['mcp'] });
    expect(text(s.stdout)).toContain('Restart Claude Desktop');
  });

  it('--project keeps everything inside the project', async () => {
    const s = setup({ bins: ['gemini'] });
    await run(['agents', 'install', '--cursor', '--gemini', '--project', '--yes'], s.deps);
    expect(JSON.parse(readFileSync(join(s.cwd, '.cursor', 'mcp.json'), 'utf8')).mcpServers.distill.command).toBe('distill-llm');
    expect(existsSync(join(s.cwd, '.agents', 'skills', 'distill-documents', 'SKILL.md'))).toBe(true);
    expect(s.calls[0]).toContain('project');
    expect(existsSync(join(s.home, '.cursor'))).toBe(false);
    expect(existsSync(join(s.home, '.agents'))).toBe(false);
  });

  it('--all installs only for detected agents', async () => {
    const s = setup({ bins: ['codex'] });
    mkdirSync(join(s.home, '.cursor'));
    await run(['agents', 'install', '--all', '--yes'], s.deps);
    expect(s.calls.map((call) => call[0])).toEqual(['codex']);
    expect(existsSync(join(s.home, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(s.home, '.gemini'))).toBe(false);
  });

  it('--all with nothing detected says so', async () => {
    const s = setup();
    await run(['agents', 'install', '--all', '--yes'], s.deps);
    expect(text(s.stdout)).toContain('No supported agents detected.');
    expect(s.exit).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const s = setup();
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    const again = setup();
    again.deps.homeDir = s.home;
    await run(['agents', 'install', '--cursor', '--yes'], again.deps);
    expect(text(again.stdout)).toContain('Already registered');
    expect(text(again.stdout)).toContain('Already installed');
  });

  it('leaves a user-written skill alone', async () => {
    const s = setup();
    const skill = join(s.home, '.agents', 'skills', 'distill-documents', 'SKILL.md');
    put(skill, '# mine\n');
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    expect(readFileSync(skill, 'utf8')).toBe('# mine\n');
    expect(text(s.stdout)).toContain('was not created by distill; leaving it');
  });

  it('refuses a cursor config that links outside the project', async () => {
    const s = setup();
    const outside = mkdtempSync(join(tmpdir(), 'distill-agents-out-'));
    put(join(outside, 'mcp.json'), '{}');
    mkdirSync(join(s.cwd, '.cursor'));
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(outside, 'mcp.json'), join(s.cwd, '.cursor', 'mcp.json'));
    await run(['agents', 'install', '--cursor', '--project', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr.join('\n')).toContain('links outside the project');
    expect(readFileSync(join(outside, 'mcp.json'), 'utf8')).toBe('{}');
  });

  it('aborts on invalid JSON without touching the file', async () => {
    const s = setup();
    const file = join(s.home, '.cursor', 'mcp.json');
    put(file, '{ nope');
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.stderr.join('\n')).toMatch(/Could not parse .*mcp\.json.*Nothing was changed/);
    expect(readFileSync(file, 'utf8')).toBe('{ nope');
  });
});

describe('agents uninstall', () => {
  it('removes the cursor entry and the skill', async () => {
    const s = setup();
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    await run(['agents', 'uninstall', '--cursor', '--yes'], setup2(s));
    expect(JSON.parse(readFileSync(join(s.home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({});
    expect(existsSync(join(s.home, '.agents', 'skills', 'distill-documents'))).toBe(false);
  });

  it('keeps the shared skill while another agent still uses it', async () => {
    const s = setup({ bins: ['codex'] });
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    put(join(s.home, '.codex', 'config.toml'), '[mcp_servers.distill]\ncommand = "distill-llm"\n');
    const out = setup({ bins: ['codex'] });
    out.deps.homeDir = s.home;
    await run(['agents', 'uninstall', '--cursor', '--yes'], out.deps);
    expect(existsSync(join(s.home, '.agents', 'skills', 'distill-documents', 'SKILL.md'))).toBe(true);
    expect(text(out.stdout)).toContain('Keeping the shared skill');
  });

  it('runs the agent CLI to remove codex', async () => {
    const s = setup({ bins: ['codex'] });
    put(join(s.home, '.codex', 'config.toml'), '[mcp_servers.distill]\ncommand = "distill-llm"\n');
    await run(['agents', 'uninstall', '--codex', '--yes'], s.deps);
    expect(s.calls).toEqual([['codex', 'mcp', 'remove', 'distill']]);
  });

  it('says there is nothing to remove', async () => {
    const s = setup();
    await run(['agents', 'uninstall', '--cursor', '--yes'], s.deps);
    expect(text(s.stdout)).toContain('Nothing to remove.');
    expect(s.exit).not.toHaveBeenCalled();
  });

  it('does not need a global install', async () => {
    const s = setup({ global: false });
    await run(['agents', 'uninstall', '--cursor', '--yes'], s.deps);
    expect(s.exit).not.toHaveBeenCalled();
  });
});

function setup2(s: ReturnType<typeof setup>) {
  const next = setup();
  next.deps.homeDir = s.home;
  return next.deps;
}

describe('agents status', () => {
  it('prints a table with detection, mcp, skill and hook', async () => {
    const s = setup({ bins: ['codex'] });
    await run(['agents', 'install', '--cursor', '--yes'], s.deps);
    const out = setup({ bins: ['codex'] });
    out.deps.homeDir = s.home;
    await run(['agents', 'status'], out.deps);
    const lines = out.stdout;
    expect(lines[0]).toMatch(/^Agent\s+Detected\s+MCP\s+Skill\s+Hook$/);
    expect(lines.find((line) => line.startsWith('Cursor'))).toMatch(/^Cursor\s+yes\s+yes\s+yes\s+-$/);
    expect(lines.find((line) => line.startsWith('Codex'))).toMatch(/yes\s+no\s+yes\s+-$/);
    expect(lines.find((line) => line.startsWith('Hermes'))).toMatch(/no\s+manual\s+no\s+-$/);
    expect(text(lines)).toContain('manual:');
    expect(lines.some((line) => line.startsWith('Claude Code'))).toBe(true);
  });
});
