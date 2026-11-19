import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandParts, jsonFileStep, parseFailure, planServerInstall, planServerRemove, serverState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const PATH = ['mcpServers', 'distill'];

function configPath(ctx: AgentContext): string {
  return join(ctx.project ? ctx.cwd : ctx.home, '.cursor', 'mcp.json');
}

function deeplink(command: string): string {
  const { bin, args } = commandParts(command, ['mcp']);
  const config = Buffer.from(JSON.stringify({ command: bin, args }), 'utf8').toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=distill&config=${encodeURIComponent(config)}`;
}

export const cursor: AgentModule = {
  id: 'cursor',
  label: 'Cursor',
  skill: 'agents',
  detect: (ctx) => ctx.which('cursor-agent') !== null || ctx.which('cursor') !== null || existsSync(join(ctx.home, '.cursor')),
  mcp(ctx): McpState {
    try {
      return serverState(readText(configPath(ctx)), PATH) === 'own' ? 'yes' : 'no';
    } catch {
      return 'no';
    }
  },
  async installSteps(ctx): Promise<Step[]> {
    const path = configPath(ctx);
    const current = readText(path);
    const { bin, args } = commandParts(ctx.command, ['mcp']);
    let plan;
    try {
      plan = planServerInstall(current, PATH, { type: 'stdio', command: bin, args });
    } catch (error) {
      throw error instanceof SyntaxError ? parseFailure(path, error) : error;
    }
    const steps: Step[] = plan.changed ? [jsonFileStep(path, current, plan)] : [{ kind: 'info', text: `Already registered: ${path}` }];
    steps.push({ kind: 'info', text: `One-click install link (opens Cursor): ${deeplink(ctx.command)}` });
    return steps;
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    const path = configPath(ctx);
    const current = readText(path);
    if (current === null) return [];
    let plan;
    try {
      plan = planServerRemove(current, PATH);
    } catch (error) {
      throw parseFailure(path, error);
    }
    return plan.changed ? [jsonFileStep(path, current, plan)] : [];
  },
};
