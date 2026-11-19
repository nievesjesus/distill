import { claudeSkillPath, isOwnSkill } from '../hooks/claude-skill';
import { agentsSkillPath, hermesSkillPath } from './skill';
import { claudeDesktop } from './claude-desktop';
import { codex } from './codex';
import { cursor } from './cursor';
import { gemini } from './gemini';
import { hermes } from './hermes';
import { readText } from './read';
import { opencode } from './opencode';
import { openclaw } from './openclaw';
import type { AgentContext, AgentId, AgentModule } from './types';
import { join } from 'node:path';

export const AGENTS: AgentModule[] = [codex, gemini, cursor, opencode, claudeDesktop, hermes, openclaw];

export function agentById(id: AgentId): AgentModule {
  return AGENTS.find((agent) => agent.id === id) as AgentModule;
}

export function agentOptionKey(id: AgentId): string {
  return id.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

export function skillPathFor(agent: AgentModule, ctx: AgentContext): string {
  return agent.skill === 'hermes' ? hermesSkillPath(ctx.home) : agentsSkillPath(ctx.project ? ctx.cwd : ctx.home);
}

function skillState(path: string): 'yes' | 'no' | 'foreign' {
  const text = readText(path);
  if (text === null) return 'no';
  return isOwnSkill(text) ? 'yes' : 'foreign';
}

export interface StatusRow {
  label: string;
  detected: string;
  mcp: string;
  skill: string;
  hook: string;
}

export function statusRows(ctx: AgentContext): StatusRow[] {
  const rows: StatusRow[] = AGENTS.map((agent) => ({
    label: agent.label,
    detected: agent.detect(ctx) ? 'yes' : 'no',
    mcp: agent.mcp(ctx),
    skill: skillState(skillPathFor(agent, ctx)),
    hook: agent.hook ? agent.hook(ctx) : '-',
  }));
  const settings = readText(join(ctx.project ? ctx.cwd : ctx.home, '.claude', ctx.project ? 'settings.local.json' : 'settings.json'));
  rows.push({
    label: 'Claude Code',
    detected: ctx.which('claude') !== null ? 'yes' : 'no',
    mcp: '-',
    skill: skillState(claudeSkillPath(ctx.project ? ctx.cwd : ctx.home)),
    hook: settings !== null && settings.includes('distill-llm') && settings.includes('hook claude') ? 'yes' : 'no',
  });
  return rows;
}

export function renderStatus(rows: StatusRow[]): string[] {
  const header: StatusRow = { label: 'Agent', detected: 'Detected', mcp: 'MCP', skill: 'Skill', hook: 'Hook' };
  const all = [header, ...rows];
  const width = (pick: (row: StatusRow) => string): number => Math.max(...all.map((row) => pick(row).length));
  const [a, b, c, d] = [width((r) => r.label), width((r) => r.detected), width((r) => r.mcp), width((r) => r.skill)];
  const lines = all.map((row) => `${row.label.padEnd(a)}  ${row.detected.padEnd(b)}  ${row.mcp.padEnd(c)}  ${row.skill.padEnd(d)}  ${row.hook}`.trimEnd());
  if (rows.some((row) => row.mcp === 'manual')) {
    lines.push('', 'manual: the agent CLI is not installed, so install prints the snippet to add by hand.');
  }
  return lines;
}
