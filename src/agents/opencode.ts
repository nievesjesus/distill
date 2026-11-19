import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOwnOpencodePlugin, opencodePluginPath, planOpencodeInstall } from '../hooks/install-opencode';
import { commandParts, jsonFileStep, parseFailure, planServerInstall, planServerRemove, serverState, textServerState } from './json-config';
import { readText } from './read';
import type { AgentContext, AgentModule, McpState, Step } from './types';

const PATH = ['mcp', 'distill'];

function configDir(ctx: AgentContext): string {
  return ctx.project ? ctx.cwd : join(ctx.home, '.config', 'opencode');
}

const jsonPath = (ctx: AgentContext): string => join(configDir(ctx), 'opencode.json');
const jsoncPath = (ctx: AgentContext): string => join(configDir(ctx), 'opencode.jsonc');
const pluginPath = (ctx: AgentContext): string => opencodePluginPath({ home: ctx.home, cwd: ctx.cwd, project: ctx.project });

function majorVersion(ctx: AgentContext): number | null {
  if (ctx.which('opencode') === null) return null;
  const result = ctx.exec('opencode', ['--version'], ctx.cwd);
  if (result.status !== 0) return null;
  const match = /(\d+)\.\d+/.exec(result.stdout);
  return match ? Number(match[1]) : null;
}

function jsonState(ctx: AgentContext): 'none' | 'own' | 'foreign' {
  try {
    return serverState(readText(jsonPath(ctx)), PATH);
  } catch {
    return 'none';
  }
}

const jsoncState = (ctx: AgentContext): 'none' | 'own' | 'foreign' => textServerState(readText(jsoncPath(ctx)), /"distill"\s*:/);

function pluginInstallSteps(ctx: AgentContext): Step[] {
  const path = pluginPath(ctx);
  const current = readText(path);
  if (current !== null && !isOwnOpencodePlugin(current)) {
    return [{ kind: 'info', text: `${path} exists and was not created by distill; leaving it.` }];
  }
  const plan = planOpencodeInstall(current, ctx.command);
  if (!plan.changed) return [{ kind: 'info', text: `Already installed: ${path}` }];
  return [{ kind: 'file', path, before: current, next: plan.next }];
}

export const opencode: AgentModule = {
  id: 'opencode',
  label: 'OpenCode',
  skill: 'agents',
  detect: (ctx) => ctx.which('opencode') !== null || existsSync(join(ctx.home, '.config', 'opencode')),
  mcp(ctx): McpState {
    if (jsonState(ctx) === 'own' || jsoncState(ctx) === 'own') return 'yes';
    return ctx.which('opencode') === null ? 'manual' : 'no';
  },
  hook(ctx) {
    const text = readText(pluginPath(ctx));
    return text !== null && isOwnOpencodePlugin(text) ? 'yes' : 'no';
  },
  async installSteps(ctx): Promise<Step[]> {
    const steps: Step[] = [];
    const { bin, args } = commandParts(ctx.command, ['mcp']);
    const major = majorVersion(ctx);
    if (jsonState(ctx) === 'own' || jsoncState(ctx) === 'own') {
      steps.push({ kind: 'info', text: 'MCP server already registered.' });
    } else if (major !== null && major < 2) {
      const path = jsonPath(ctx);
      const current = readText(path);
      try {
        const plan = planServerInstall(current, PATH, { type: 'local', command: [bin, ...args], enabled: true });
        steps.push(jsonFileStep(path, current, plan));
      } catch (error) {
        steps.push({
          kind: 'manual',
          title: error instanceof SyntaxError ? `${path} is not plain JSON (${error.message}); add the server by hand` : String(error instanceof Error ? error.message : error),
          path,
          lines: ['"mcp": { "distill": { "type": "local", "command": ' + JSON.stringify([bin, ...args]) + ', "enabled": true } }'],
        });
      }
    } else {
      steps.push({
        kind: 'manual',
        title: major === null ? 'could not detect the OpenCode version; add the server by hand (OpenCode 2.x shape shown)' : 'OpenCode 2.x: add the server by hand',
        path: jsoncPath(ctx),
        lines: ['{', '  "mcp": {', '    "servers": {', `      "distill": { "type": "local", "command": ${JSON.stringify([bin, ...args])} }`, '    }', '  }', '}'],
      });
    }
    steps.push(...pluginInstallSteps(ctx));
    return steps;
  },
  async uninstallSteps(ctx): Promise<Step[]> {
    const steps: Step[] = [];
    const path = jsonPath(ctx);
    const current = readText(path);
    if (current !== null) {
      try {
        const plan = planServerRemove(current, PATH);
        if (plan.changed) steps.push(jsonFileStep(path, current, plan));
      } catch (error) {
        throw parseFailure(path, error);
      }
    }
    if (jsoncState(ctx) === 'own') {
      steps.push({ kind: 'manual', title: 'remove the server by hand', path: jsoncPath(ctx), lines: ['Delete mcp.servers.distill.'] });
    }
    const plugin = readText(pluginPath(ctx));
    if (plugin !== null && isOwnOpencodePlugin(plugin)) steps.push({ kind: 'file', path: pluginPath(ctx), before: plugin, next: null });
    return steps;
  },
};
