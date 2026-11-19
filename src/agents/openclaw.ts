import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execStep, textServerState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const configPath = (ctx: AgentContext): string => join(ctx.home, '.openclaw', 'openclaw.json');

const state = (ctx: AgentContext): 'none' | 'own' | 'foreign' => textServerState(readText(configPath(ctx)), /["']?distill["']?\s*:/);

export const openclaw: AgentModule = {
  id: 'openclaw',
  label: 'OpenClaw',
  skill: 'agents',
  detect: (ctx) => ctx.which('openclaw') !== null || existsSync(join(ctx.home, '.openclaw')),
  mcp(ctx): McpState {
    if (state(ctx) === 'own') return 'yes';
    return ctx.which('openclaw') === null ? 'manual' : 'no';
  },
  async installSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [{ kind: 'info', text: 'OpenClaw keeps MCP servers in ~/.openclaw only; skipping the MCP server (run without --project).' }];
    const current = state(ctx);
    if (current === 'own') return [{ kind: 'info', text: `Already registered: ${configPath(ctx)}` }];
    if (current === 'foreign') return [{ kind: 'info', text: `${configPath(ctx)} has a distill server that was not created by distill; leaving it.` }];
    const { bin, args } = ctx.mcp;
    const entry = JSON.stringify({ command: bin, args });
    if (ctx.which('openclaw') === null) {
      return [
        {
          kind: 'manual',
          title: 'openclaw is not installed; add the server by hand',
          path: configPath(ctx),
          lines: ['{', '  mcp: {', '    servers: {', `      distill: ${entry},`, '    },', '  },', '}'],
        },
      ];
    }
    return [execStep('openclaw', ['mcp', 'set', 'distill', entry])];
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [];
    const current = state(ctx);
    if (current === 'none') return [];
    if (current === 'foreign') return [{ kind: 'info', text: `${configPath(ctx)} has a distill server that was not created by distill; leaving it.` }];
    if (ctx.which('openclaw') === null) {
      return [{ kind: 'manual', title: 'openclaw is not installed; remove the server by hand', path: configPath(ctx), lines: ['Delete mcp.servers.distill.'] }];
    }
    return [execStep('openclaw', ['mcp', 'unset', 'distill'])];
  },
};
