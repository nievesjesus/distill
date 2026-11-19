import type { Exec } from './exec';

export type AgentId = 'codex' | 'gemini' | 'cursor' | 'opencode' | 'claude-desktop' | 'hermes' | 'openclaw';

export interface AgentContext {
  home: string;
  cwd: string;
  project: boolean;
  command: string;
  mcp: { bin: string; args: string[] };
  exec: Exec;
  which: (bin: string) => string | null;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

export type Step =
  | { kind: 'file'; path: string; before: string | null; next: string | null; note?: string }
  | { kind: 'exec'; bin: string; args: string[]; display: string }
  | { kind: 'manual'; title: string; path: string; lines: string[] }
  | { kind: 'info'; text: string };

export type McpState = 'yes' | 'no' | 'manual';

export interface AgentModule {
  id: AgentId;
  label: string;
  skill: 'agents' | 'hermes';
  detect(ctx: AgentContext): boolean;
  installSteps(ctx: AgentContext): Promise<Step[]>;
  uninstallSteps(ctx: AgentContext): Promise<Step[]>;
  mcp(ctx: AgentContext): McpState;
  hook?(ctx: AgentContext): 'yes' | 'no';
}
