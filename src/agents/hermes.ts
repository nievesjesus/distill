import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execStep, textServerState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const configPath = (ctx: AgentContext): string => join(ctx.home, '.hermes', 'config.yaml');

const state = (ctx: AgentContext): 'none' | 'own' | 'foreign' => textServerState(readText(configPath(ctx)), /^\s+distill:\s*$/m);

export const hermes: AgentModule = {
  id: 'hermes',
  label: 'Hermes Agent',
  skill: 'hermes',
  detect: (ctx) => ctx.which('hermes') !== null || existsSync(join(ctx.home, '.hermes')),
  mcp(ctx): McpState {
    if (state(ctx) === 'own') return 'yes';
    return ctx.which('hermes') === null ? 'manual' : 'no';
  },
  async installSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [{ kind: 'info', text: 'Hermes keeps MCP servers and skills in ~/.hermes only; skipping (run without --project).' }];
    const current = state(ctx);
    if (current === 'own') return [{ kind: 'info', text: `Already registered: ${configPath(ctx)}` }];
    if (current === 'foreign') return [{ kind: 'info', text: `${configPath(ctx)} has a distill server that was not created by distill; leaving it.` }];
    const { bin, args } = ctx.mcp;
    if (ctx.which('hermes') === null) {
      return [
        {
          kind: 'manual',
          title: 'hermes is not installed; add the server by hand',
          path: configPath(ctx),
          lines: ['mcp_servers:', '  distill:', `    command: ${JSON.stringify(bin)}`, `    args: ${JSON.stringify(args)}`],
        },
      ];
    }
    return [execStep('hermes', ['mcp', 'add', 'distill', '--command', bin, '--args', ...args])];
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [];
    const current = state(ctx);
    if (current === 'none') return [];
    if (current === 'foreign') return [{ kind: 'info', text: `${configPath(ctx)} has a distill server that was not created by distill; leaving it.` }];
    if (ctx.which('hermes') === null) {
      return [{ kind: 'manual', title: 'hermes is not installed; remove the server by hand', path: configPath(ctx), lines: ['Delete mcp_servers.distill.'] }];
    }
    return [execStep('hermes', ['mcp', 'remove', 'distill'])];
  },
};
