import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsonFileStep, parseFailure, planServerInstall, planServerRemove, serverState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const PATH = ['mcpServers', 'distill'];

function configPath(ctx: AgentContext): string {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (ctx.platform === 'win32') return join(ctx.env.APPDATA ?? join(ctx.home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(ctx.home, '.config', 'Claude', 'claude_desktop_config.json');
}

export const claudeDesktop: AgentModule = {
  id: 'claude-desktop',
  label: 'Claude Desktop',
  skill: 'agents',
  detect: (ctx) => existsSync(dirname(configPath(ctx))),
  mcp(ctx): McpState {
    try {
      return serverState(readText(configPath(ctx)), PATH) === 'own' ? 'yes' : 'no';
    } catch {
      return 'no';
    }
  },
  async installSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [{ kind: 'info', text: 'Claude Desktop has a single user-level config; skipping (run without --project).' }];
    const path = configPath(ctx);
    const current = readText(path);
    const { bin, args } = ctx.mcp;
    let plan;
    try {
      plan = planServerInstall(current, PATH, { command: bin, args });
    } catch (error) {
      throw error instanceof SyntaxError ? parseFailure(path, error) : error;
    }
    if (!plan.changed) return [{ kind: 'info', text: `Already registered: ${path}` }];
    return [jsonFileStep(path, current, plan), { kind: 'info', text: 'Restart Claude Desktop to load the distill server.' }];
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    if (ctx.project) return [];
    const path = configPath(ctx);
    const current = readText(path);
    if (current === null) return [];
    let plan;
    try {
      plan = planServerRemove(current, PATH);
    } catch (error) {
      throw parseFailure(path, error);
    }
    return plan.changed ? [jsonFileStep(path, current, plan), { kind: 'info', text: 'Restart Claude Desktop to unload the distill server.' }] : [];
  },
};
