import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentContext, Step } from '../../src/agents/types';
import { AGENTS, agentById } from '../../src/agents/index';
import { opencodePluginPath } from '../../src/hooks/install-opencode';

function ctx(overrides: Partial<AgentContext> & { bins?: string[]; opencodeVersion?: string } = {}): AgentContext & { calls: string[][] } {
  const calls: string[][] = [];
  const bins = overrides.bins ?? [];
  return {
    home: overrides.home ?? mkdtempSync(join(tmpdir(), 'distill-agents-home-')),
    cwd: overrides.cwd ?? mkdtempSync(join(tmpdir(), 'distill-agents-cwd-')),
    project: overrides.project ?? false,
    command: overrides.command ?? 'distill-llm',
    mcp: overrides.mcp ?? { bin: 'distill-llm', args: ['mcp'] },
    env: overrides.env ?? {},
    platform: overrides.platform ?? 'darwin',
    which: (bin: string) => (bins.includes(bin) ? `/usr/bin/${bin}` : null),
    exec: (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      if (bin === 'opencode' && args[0] === '--version') return { status: 0, stdout: `${overrides.opencodeVersion ?? '1.2.27'}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    calls,
  };
}

const kinds = (steps: Step[]) => steps.map((step) => step.kind);
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe('codex', () => {
  const codex = agentById('codex');

  it('adds the server through the CLI and prints the TOML follow-up', async () => {
    const steps = await codex.installSteps(ctx({ bins: ['codex'] }));
    expect(steps[0]).toMatchObject({ kind: 'exec', bin: 'codex', args: ['mcp', 'add', 'distill', '--', 'distill-llm', 'mcp'] });
    const manual = steps.find((step) => step.kind === 'manual');
    expect(manual?.kind === 'manual' && manual.lines.join('\n')).toContain('startup_timeout_sec = 60');
    expect(manual?.kind === 'manual' && manual.lines.join('\n')).toContain(
      'env_vars = ["DISTILL_NO_SAVINGS_NOTE", "DISTILL_MCP_MAX_TOKENS", "DISTILL_INDEX_MIN_TOKENS", "DISTILL_NO_STATS"]',
    );
  });

  it('is manual when the CLI is missing', async () => {
    const steps = await codex.installSteps(ctx());
    expect(kinds(steps)).toEqual(['manual']);
  });

  it('skips when already registered and removes through the CLI', async () => {
    const c = ctx({ bins: ['codex'] });
    put(join(c.home, '.codex', 'config.toml'), '[mcp_servers.distill]\ncommand = "distill-llm"\nargs = ["mcp"]\n');
    expect(kinds(await codex.installSteps(c))).toEqual(['info']);
    expect(codex.mcp(c)).toBe('yes');
    const removal = await codex.uninstallSteps(c);
    expect(removal[0]).toMatchObject({ kind: 'exec', args: ['mcp', 'remove', 'distill'] });
  });

  it('leaves a distill server that is not ours', async () => {
    const c = ctx({ bins: ['codex'] });
    put(join(c.home, '.codex', 'config.toml'), '[mcp_servers.distill]\ncommand = "mine"\n');
    expect(kinds(await codex.installSteps(c))).toEqual(['info']);
    expect(kinds(await codex.uninstallSteps(c))).toEqual(['info']);
  });

  it('has no project scope', async () => {
    expect(kinds(await codex.installSteps(ctx({ bins: ['codex'], project: true })))).toEqual(['info']);
  });
});

describe('gemini', () => {
  const gemini = agentById('gemini');

  it('uses user scope with a 60 s timeout, project scope with --project', async () => {
    const user = await gemini.installSteps(ctx({ bins: ['gemini'] }));
    expect(user[0]).toMatchObject({ kind: 'exec', bin: 'gemini', args: ['mcp', 'add', '-s', 'user', '--timeout', '60000', 'distill', 'distill-llm', 'mcp'] });
    const project = await gemini.installSteps(ctx({ bins: ['gemini'], project: true }));
    expect(project[0]).toMatchObject({ args: ['mcp', 'add', '-s', 'project', '--timeout', '60000', 'distill', 'distill-llm', 'mcp'] });
  });

  it('removes with the same scope when registered', async () => {
    const c = ctx({ bins: ['gemini'] });
    put(join(c.home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { distill: { command: 'distill-llm', args: ['mcp'] } } }));
    expect(gemini.mcp(c)).toBe('yes');
    expect((await gemini.uninstallSteps(c))[0]).toMatchObject({ args: ['mcp', 'remove', '-s', 'user', 'distill'] });
    expect(kinds(await gemini.installSteps(c))).toEqual(['info']);
  });

  it('is manual without the CLI', async () => {
    expect(kinds(await gemini.installSteps(ctx()))).toEqual(['manual']);
  });
});

describe('cursor', () => {
  const cursor = agentById('cursor');

  it('edits ~/.cursor/mcp.json and prints the deeplink', async () => {
    const c = ctx();
    const steps = await cursor.installSteps(c);
    const file = steps[0];
    expect(file.kind === 'file' && file.path).toBe(join(c.home, '.cursor', 'mcp.json'));
    expect(JSON.parse((file.kind === 'file' && file.next) || '{}').mcpServers.distill).toEqual({ type: 'stdio', command: 'distill-llm', args: ['mcp'] });
    const info = steps.find((step) => step.kind === 'info');
    const text = info?.kind === 'info' ? info.text : '';
    const match = /config=(\S+)/.exec(text);
    expect(text).toContain('cursor://anysphere.cursor-deeplink/mcp/install?name=distill&config=');
    expect(JSON.parse(Buffer.from(decodeURIComponent(match?.[1] ?? ''), 'base64').toString('utf8'))).toEqual({ command: 'distill-llm', args: ['mcp'] });
  });

  it('uses .cursor/mcp.json in the project', async () => {
    const c = ctx({ project: true });
    const file = (await cursor.installSteps(c))[0];
    expect(file.kind === 'file' && file.path).toBe(join(c.cwd, '.cursor', 'mcp.json'));
  });

  it('removes only our entry', async () => {
    const c = ctx();
    put(join(c.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'o' }, distill: { type: 'stdio', command: 'distill-llm', args: ['mcp'] } } }));
    const file = (await cursor.uninstallSteps(c))[0];
    expect(JSON.parse((file.kind === 'file' && file.next) || '{}')).toEqual({ mcpServers: { other: { command: 'o' } } });
    expect(cursor.mcp(c)).toBe('yes');
  });

  it('refuses a distill entry that is not ours', async () => {
    const c = ctx();
    put(join(c.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { distill: { command: 'mine' } } }));
    await expect(cursor.installSteps(c)).rejects.toThrow(/not created by distill/);
  });

  it('reports a parse error', async () => {
    const c = ctx();
    put(join(c.home, '.cursor', 'mcp.json'), '{ nope');
    await expect(cursor.installSteps(c)).rejects.toThrow(/Could not parse .*mcp\.json.*Nothing was changed/);
  });
});

describe('absolute launcher', () => {
  const mcp = { bin: '/opt/node/bin/node', args: ['/opt/lib/node_modules/distill-llm/dist/cli.js', 'mcp'] };

  it('is used for the config entry and the deeplink, and still recognized as ours', async () => {
    const c = ctx({ mcp });
    const steps = await agentById('cursor').installSteps(c);
    const file = steps[0];
    const next = (file.kind === 'file' && file.next) || '{}';
    expect(JSON.parse(next).mcpServers.distill).toEqual({ type: 'stdio', command: mcp.bin, args: mcp.args });
    const info = steps.find((step) => step.kind === 'info');
    const config = /config=(\S+)/.exec(info?.kind === 'info' ? info.text : '')?.[1] ?? '';
    expect(JSON.parse(Buffer.from(decodeURIComponent(config), 'base64').toString('utf8'))).toEqual({ command: mcp.bin, args: mcp.args });
    put(join(c.home, '.cursor', 'mcp.json'), next);
    expect(agentById('cursor').mcp(c)).toBe('yes');
  });

  it('recognizes a development checkout path as ours', async () => {
    const c = ctx({ mcp: { bin: '/n/node', args: ['/Users/me/code/distill/dist/cli.js', 'mcp'] } });
    const file = (await agentById('cursor').installSteps(c))[0];
    put(join(c.home, '.cursor', 'mcp.json'), (file.kind === 'file' && file.next) || '{}');
    expect(agentById('cursor').mcp(c)).toBe('yes');
  });

  it('is passed to the agent CLIs', async () => {
    const steps = await agentById('codex').installSteps(ctx({ bins: ['codex'], mcp }));
    expect(steps[0]).toMatchObject({ args: ['mcp', 'add', 'distill', '--', mcp.bin, ...mcp.args] });
  });
});

describe('claude-desktop', () => {
  const desktop = agentById('claude-desktop');

  it('resolves the config path per platform', async () => {
    const mac = ctx({ platform: 'darwin' });
    expect(((await desktop.installSteps(mac))[0] as { path: string }).path).toBe(join(mac.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    const win = ctx({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } });
    expect(((await desktop.installSteps(win))[0] as { path: string }).path).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    const linux = ctx({ platform: 'linux' });
    expect(((await desktop.installSteps(linux))[0] as { path: string }).path).toBe(join(linux.home, '.config', 'Claude', 'claude_desktop_config.json'));
  });

  it('writes command and args without a type and says to restart', async () => {
    const steps = await desktop.installSteps(ctx());
    const file = steps[0];
    expect(JSON.parse((file.kind === 'file' && file.next) || '{}').mcpServers.distill).toEqual({ command: 'distill-llm', args: ['mcp'] });
    const info = steps.find((step) => step.kind === 'info');
    expect(info?.kind === 'info' && info.text).toMatch(/Restart Claude Desktop/);
  });

  it('has no project scope', async () => {
    expect(kinds(await desktop.installSteps(ctx({ project: true })))).toEqual(['info']);
  });
});

describe('opencode', () => {
  const opencode = agentById('opencode');

  it('edits opencode.json on V1 and installs the plugin', async () => {
    const c = ctx({ bins: ['opencode'] });
    const steps = await opencode.installSteps(c);
    const config = steps[0];
    expect(config.kind === 'file' && config.path).toBe(join(c.home, '.config', 'opencode', 'opencode.json'));
    expect(JSON.parse((config.kind === 'file' && config.next) || '{}').mcp.distill).toEqual({ type: 'local', command: ['distill-llm', 'mcp'], enabled: true });
    const plugin = steps.find((step) => step.kind === 'file' && step.path === opencodePluginPath({ home: c.home, cwd: c.cwd, project: false }));
    expect(plugin).toBeDefined();
  });

  it('is manual on V2 and still installs the plugin', async () => {
    const c = ctx({ bins: ['opencode'], opencodeVersion: '2.3.2' });
    const steps = await opencode.installSteps(c);
    const manual = steps.find((step) => step.kind === 'manual');
    expect(manual?.kind === 'manual' && manual.path).toBe(join(c.home, '.config', 'opencode', 'opencode.jsonc'));
    expect(manual?.kind === 'manual' && manual.lines.join('\n')).toContain('"servers"');
    expect(steps.some((step) => step.kind === 'file' && step.path.endsWith('distill.js'))).toBe(true);
  });

  it('is manual when the version cannot be detected', async () => {
    const steps = await opencode.installSteps(ctx());
    expect(steps.some((step) => step.kind === 'manual')).toBe(true);
  });

  it('uses project files with --project', async () => {
    const c = ctx({ bins: ['opencode'], project: true });
    const steps = await opencode.installSteps(c);
    expect(steps[0].kind === 'file' && steps[0].path).toBe(join(c.cwd, 'opencode.json'));
    expect(steps.some((step) => step.kind === 'file' && step.path === join(c.cwd, '.opencode', 'plugins', 'distill.js'))).toBe(true);
  });

  it('refuses to replace a plugin file that is not ours but keeps going', async () => {
    const c = ctx({ bins: ['opencode'] });
    put(opencodePluginPath({ home: c.home, cwd: c.cwd, project: false }), 'export const mine = 1;');
    const steps = await opencode.installSteps(c);
    expect(steps.some((step) => step.kind === 'file' && step.path.endsWith('distill.js'))).toBe(false);
    expect(steps.some((step) => step.kind === 'info' && /not created by distill/.test(step.text))).toBe(true);
  });

  it('uninstalls the entry and the plugin, and reports hook state', async () => {
    const c = ctx({ bins: ['opencode'] });
    const install = await opencode.installSteps(c);
    for (const step of install) {
      if (step.kind === 'file' && step.next !== null) put(step.path, step.next);
    }
    expect(opencode.mcp(c)).toBe('yes');
    expect(opencode.hook?.(c)).toBe('yes');
    const removal = await opencode.uninstallSteps(c);
    const config = removal.find((step) => step.kind === 'file' && step.path.endsWith('opencode.json'));
    expect(JSON.parse((config?.kind === 'file' && config.next) || 'null')).toEqual({});
    const plugin = removal.find((step) => step.kind === 'file' && step.path.endsWith('distill.js'));
    expect(plugin?.kind === 'file' && plugin.next).toBeNull();
  });
});

describe('hermes', () => {
  const hermes = agentById('hermes');

  it('adds through the CLI', async () => {
    const steps = await hermes.installSteps(ctx({ bins: ['hermes'] }));
    expect(steps[0]).toMatchObject({ kind: 'exec', bin: 'hermes', args: ['mcp', 'add', 'distill', '--command', 'distill-llm', '--args', 'mcp'] });
  });

  it('prints the YAML snippet without the CLI', async () => {
    const c = ctx();
    const manual = (await hermes.installSteps(c))[0];
    expect(manual.kind).toBe('manual');
    expect(manual.kind === 'manual' && manual.path).toBe(join(c.home, '.hermes', 'config.yaml'));
    expect(manual.kind === 'manual' && manual.lines.join('\n')).toContain('mcp_servers:');
  });

  it('removes through the CLI when registered', async () => {
    const c = ctx({ bins: ['hermes'] });
    put(join(c.home, '.hermes', 'config.yaml'), 'mcp_servers:\n  distill:\n    command: "distill-llm"\n    args: ["mcp"]\n');
    expect(hermes.mcp(c)).toBe('yes');
    expect((await hermes.uninstallSteps(c))[0]).toMatchObject({ args: ['mcp', 'remove', 'distill'] });
  });

  it('has no project scope', async () => {
    expect(kinds(await hermes.installSteps(ctx({ bins: ['hermes'], project: true })))).toEqual(['info']);
  });
});

describe('openclaw', () => {
  const openclaw = agentById('openclaw');

  it('sets the server as JSON through the CLI', async () => {
    const steps = await openclaw.installSteps(ctx({ bins: ['openclaw'] }));
    expect(steps[0]).toMatchObject({ kind: 'exec', bin: 'openclaw', args: ['mcp', 'set', 'distill', '{"command":"distill-llm","args":["mcp"]}'] });
  });

  it('prints the JSON5 snippet without the CLI and removes with unset', async () => {
    expect(kinds(await openclaw.installSteps(ctx()))).toEqual(['manual']);
    const c = ctx({ bins: ['openclaw'] });
    put(join(c.home, '.openclaw', 'openclaw.json'), '{ mcp: { servers: { distill: { command: "distill-llm", args: ["mcp"] } } } }');
    expect(openclaw.mcp(c)).toBe('yes');
    expect((await openclaw.uninstallSteps(c))[0]).toMatchObject({ args: ['mcp', 'unset', 'distill'] });
  });
});

describe('registry', () => {
  it('lists the seven agents', () => {
    expect(AGENTS.map((agent) => agent.id)).toEqual(['codex', 'gemini', 'cursor', 'opencode', 'claude-desktop', 'hermes', 'openclaw']);
  });

  it('detects by binary or by config directory', () => {
    const c = ctx({ bins: ['codex'] });
    expect(agentById('codex').detect(c)).toBe(true);
    expect(agentById('gemini').detect(c)).toBe(false);
    mkdirSync(join(c.home, '.cursor'));
    expect(agentById('cursor').detect(c)).toBe(true);
  });

  it('marks mcp as manual when the CLI is missing', () => {
    expect(agentById('hermes').mcp(ctx())).toBe('manual');
    expect(agentById('hermes').mcp(ctx({ bins: ['hermes'] }))).toBe('no');
  });
});
