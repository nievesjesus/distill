import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execStep, textServerState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const ENV_VARS = ['DISTILL_NO_SAVINGS_NOTE', 'DISTILL_MCP_MAX_TOKENS', 'DISTILL_INDEX_MIN_TOKENS', 'DISTILL_NO_STATS'];
const TIMEOUT_LINE = 'startup_timeout_sec = 60';
const ENV_LINE = `env_vars = [${ENV_VARS.map((name) => `"${name}"`).join(', ')}]`;

function codexHome(ctx: AgentContext): string {
  return ctx.env.CODEX_HOME ?? join(ctx.home, '.codex');
}

function configPath(ctx: AgentContext): string {
  return join(codexHome(ctx), 'config.toml');
}

function state(ctx: AgentContext): 'none' | 'own' | 'foreign' {
  const text = readText(configPath(ctx));
  if (text === null) return 'none';
  const start = text.search(/^\[mcp_servers\.distill\]\s*$/m);
  if (start < 0) return 'none';
  const rest = text.slice(start + 1);
  const end = rest.search(/^\[/m);
  return textServerState(end < 0 ? rest : rest.slice(0, end), /./);
}

const PROJECT_NOTE = 'Codex CLI keeps MCP servers in ~/.codex/config.toml only; skipping the MCP server (run without --project to register it).';

export const codex: AgentModule = {
  id: 'codex',
  label: 'Codex CLI (and the ChatGPT desktop app)',
  skill: 'agents',
  detect: (ctx) => ctx.which('codex') !== null || existsSync(codexHome(ctx)),
  mcp(ctx): McpState {
    if (state(ctx) === 'own') return 'yes';
    return ctx.which('codex') === null ? 'manual' : 'no';
  },
  async installSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [{ kind: 'info', text: PROJECT_NOTE }];
    const current = state(ctx);
    if (current === 'own') return [{ kind: 'info', text: `Already registered: ${configPath(ctx)}` }];
    if (current === 'foreign') return [{ kind: 'info', text: `${configPath(ctx)} has an mcp_servers.distill entry that was not created by distill; leaving it.` }];
    const { bin, args } = ctx.mcp;
    const followUp = [
      'Codex has no flag for these, so add them to the [mcp_servers.distill] table:',
      TIMEOUT_LINE,
      ENV_LINE,
    ];
    if (ctx.which('codex') === null) {
      return [
        {
          kind: 'manual',
          title: 'codex is not installed; add the server by hand',
          path: configPath(ctx),
          lines: ['[mcp_servers.distill]', `command = ${JSON.stringify(bin)}`, `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`, TIMEOUT_LINE, ENV_LINE],
        },
      ];
    }
    return [
      execStep('codex', ['mcp', 'add', 'distill', '--', bin, ...args]),
      { kind: 'manual', title: 'set the startup timeout and the environment forwarding', path: configPath(ctx), lines: followUp },
    ];
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    const current = state(ctx);
    if (current === 'none') return [];
    if (current === 'foreign') return [{ kind: 'info', text: `${configPath(ctx)} has an mcp_servers.distill entry that was not created by distill; leaving it.` }];
    if (ctx.which('codex') === null) {
      return [{ kind: 'manual', title: 'codex is not installed; remove the table by hand', path: configPath(ctx), lines: ['Delete the [mcp_servers.distill] table.'] }];
    }
    return [execStep('codex', ['mcp', 'remove', 'distill'])];
  },
};
