import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isInside } from '../node/inside';
import { type MatchContext, type ReadRule, parseReadRule, ruleMayMatch } from './read-rules';
import { isHookConvertible } from './supported';

export interface ClaudeHookDeps {
  homeDir: string;
  projectDir?: string;
  managedSettingsPaths?: string[];
  platform?: NodeJS.Platform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface SettingsFile {
  path: string;
  root: string | null;
}

function readRules(permissions: Record<string, unknown>, key: string, root: string | null): ReadRule[] {
  const rules = permissions[key];
  if (!Array.isArray(rules)) return [];
  const parsed: ReadRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'string') continue;
    const read = parseReadRule(rule, root);
    if (read !== null) parsed.push(read);
  }
  return parsed;
}

async function hasReadRestriction(file: SettingsFile, paths: string[], ctx: MatchContext): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file.path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR';
  }
  try {
    const settings: unknown = JSON.parse(text);
    if (!isRecord(settings) || !isRecord(settings.permissions)) return false;
    const rules = [...readRules(settings.permissions, 'deny', file.root), ...readRules(settings.permissions, 'ask', file.root)];
    return rules.some((rule) => paths.some((path) => ruleMayMatch(rule, path, ctx)));
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

function settingsFiles(realCwd: string, realProject: string | null, deps: ClaudeHookDeps): SettingsFile[] {
  const dirs = [...(realProject === null ? [] : [realProject]), ...ancestors(realCwd)];
  const files: SettingsFile[] = [
    { path: join(deps.homeDir, '.claude', 'settings.json'), root: null },
    ...(deps.managedSettingsPaths ?? defaultManagedSettingsPaths()).map((path) => ({ path, root: null })),
  ];
  for (const dir of dirs) {
    files.push({ path: join(dir, '.claude', 'settings.json'), root: dir }, { path: join(dir, '.claude', 'settings.local.json'), root: dir });
  }
  const seen = new Set<string>();
  return files.filter((file) => !seen.has(file.path) && seen.add(file.path));
}

async function anyReadRestriction(files: SettingsFile[], paths: string[], ctx: MatchContext): Promise<boolean> {
  return (await Promise.all(files.map((file) => hasReadRestriction(file, paths, ctx)))).some(Boolean);
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
    const ctx: MatchContext = { cwd: realCwd, home: deps.homeDir, platform: deps.platform ?? process.platform };
    const candidates = [original, realOriginal, join(deps.homeDir, '.cache', 'distill-llm', 'out', 'probe.md')];
    if (await anyReadRestriction(settingsFiles(realCwd, realProject, deps), candidates, ctx)) return null;
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
