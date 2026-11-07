import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isHookConvertible } from './supported';

export interface ClaudeHookDeps {
  homeDir: string;
  projectDir?: string;
  managedSettingsPaths?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

function readRuleList(permissions: Record<string, unknown>, key: string): boolean {
  const rules = permissions[key];
  return Array.isArray(rules) && rules.some((rule) => typeof rule === 'string' && rule.startsWith('Read'));
}

async function hasReadRestriction(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR';
  }
  try {
    const settings: unknown = JSON.parse(text);
    if (!isRecord(settings) || !isRecord(settings.permissions)) return false;
    return readRuleList(settings.permissions, 'deny') || readRuleList(settings.permissions, 'ask');
  } catch {
    return true;
  }
}

export function defaultManagedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (platform === 'win32') return ['C:\\ProgramData\\ClaudeCode\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

function ancestors(dir: string): string[] {
  const dirs: string[] = [];
  let current = dir;
  for (;;) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function settingsFiles(realCwd: string, realProject: string | null, deps: ClaudeHookDeps): string[] {
  const dirs = [...(realProject === null ? [] : [realProject]), ...ancestors(realCwd)];
  const files = [join(deps.homeDir, '.claude', 'settings.json'), ...(deps.managedSettingsPaths ?? defaultManagedSettingsPaths())];
  for (const dir of dirs) files.push(join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'));
  return [...new Set(files)];
}

async function anyReadRestriction(files: string[]): Promise<boolean> {
  return (await Promise.all(files.map(hasReadRestriction))).some(Boolean);
}

async function realpathOrNull(path: string | undefined): Promise<string | null> {
  if (path === undefined || path === '') return null;
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function handleClaudePreToolUse(
  payload: unknown,
  convert: (absPath: string) => Promise<string>,
  deps: ClaudeHookDeps,
): Promise<object | null> {
  try {
    if (!isRecord(payload) || payload.tool_name !== 'Read' || !isRecord(payload.tool_input)) return null;
    const toolInput = payload.tool_input;
    if (toolInput.pages !== undefined || typeof toolInput.file_path !== 'string') return null;
    if (!isHookConvertible(toolInput.file_path)) return null;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const original = isAbsolute(toolInput.file_path) ? toolInput.file_path : resolve(cwd, toolInput.file_path);
    const [realOriginal, realCwd, realProject] = await Promise.all([realpath(original), realpath(cwd), realpathOrNull(deps.projectDir)]);
    if (!isInside(realOriginal, realCwd) && !(realProject !== null && isInside(realOriginal, realProject))) return null;
    if (await anyReadRestriction(settingsFiles(realCwd, realProject, deps))) return null;
    const mdPath = await convert(realOriginal);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...toolInput, file_path: mdPath },
        additionalContext: `distill converted ${basename(original)} to Markdown to save tokens. Original file: ${original}.`,
      },
    };
  } catch {
    return null;
  }
}
