import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandParts, execStep, serverState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const TIMEOUT_MS = '60000';

function settingsPath(ctx: AgentContext): string {
  return join(ctx.project ? ctx.cwd : ctx.home, '.gemini', 'settings.json');
}

function state(ctx: AgentContext): 'none' | 'own' | 'foreign' {
  try {
    return serverState(readText(settingsPath(ctx)), ['mcpServers', 'distill']);
  } catch {
    return 'none';
  }
}

const scope = (ctx: AgentContext): string => (ctx.project ? 'project' : 'user');

export const gemini: AgentModule = {
  id: 'gemini',
  label: 'Gemini CLI',
  skill: 'agents',
  detect: (ctx) => ctx.which('gemini') !== null || existsSync(join(ctx.home, '.gemini')),
  mcp(ctx): McpState {
    if (state(ctx) === 'own') return 'yes';
    return ctx.which('gemini') === null ? 'manual' : 'no';
  },
  async installSteps(ctx): Promise<Step[]> {
    const current = state(ctx);
    if (current === 'own') return [{ kind: 'info', text: `Already registered: ${settingsPath(ctx)}` }];
    if (current === 'foreign') return [{ kind: 'info', text: `${settingsPath(ctx)} has an mcpServers.distill entry that was not created by distill; leaving it.` }];
    const { bin, args } = commandParts(ctx.command, ['mcp']);
    if (ctx.which('gemini') === null) {
      return [
        {
          kind: 'manual',
          title: 'gemini is not installed; add the server by hand',
          path: settingsPath(ctx),
          lines: ['{', '  "mcpServers": {', `    "distill": { "command": ${JSON.stringify(bin)}, "args": ${JSON.stringify(args)}, "timeout": ${TIMEOUT_MS} }`, '  }', '}'],
        },
      ];
    }
    return [execStep('gemini', ['mcp', 'add', '-s', scope(ctx), '--timeout', TIMEOUT_MS, 'distill', bin, ...args])];
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    const current = state(ctx);
    if (current === 'none') return [];
    if (current === 'foreign') return [{ kind: 'info', text: `${settingsPath(ctx)} has an mcpServers.distill entry that was not created by distill; leaving it.` }];
    if (ctx.which('gemini') === null) {
      return [{ kind: 'manual', title: 'gemini is not installed; remove the entry by hand', path: settingsPath(ctx), lines: ['Delete mcpServers.distill.'] }];
    }
    return [execStep('gemini', ['mcp', 'remove', '-s', scope(ctx), 'distill'])];
  },
};
