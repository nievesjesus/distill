import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { isHookConvertible } from './supported';

export interface ClaudeHookDeps {
  homeDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

async function hasReadDenyRule(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try {
    const settings: unknown = JSON.parse(text);
    if (!isRecord(settings) || !isRecord(settings.permissions)) return false;
    const deny = settings.permissions.deny;
    return Array.isArray(deny) && deny.some((rule) => typeof rule === 'string' && rule.startsWith('Read'));
  } catch {
    return true;
  }
}

async function anyReadDenyRule(cwd: string, homeDir: string): Promise<boolean> {
  const files = [
    join(homeDir, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  return (await Promise.all(files.map(hasReadDenyRule))).some(Boolean);
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
    const [realOriginal, realCwd] = await Promise.all([realpath(original), realpath(cwd)]);
    if (!isInside(realOriginal, realCwd)) return null;
    if (await anyReadDenyRule(realCwd, deps.homeDir)) return null;
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
