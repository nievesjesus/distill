import { join } from 'node:path';
import { opencodePluginSource, PLUGIN_ID } from './opencode-plugin';
import type { Plan } from './install-claude';

export interface OpencodeLocation {
  home: string;
  cwd: string;
  project: boolean;
}

export function opencodePluginPath(location: OpencodeLocation): string {
  return location.project
    ? join(location.cwd, '.opencode', 'plugins', 'distill.js')
    : join(location.home, '.config', 'opencode', 'plugins', 'distill.js');
}

export function planOpencodeInstall(current: string | null, command: string): Plan {
  const next = opencodePluginSource(command);
  return { next, changed: current !== next };
}

export function isOwnOpencodePlugin(text: string): boolean {
  return text.includes(PLUGIN_ID);
}
