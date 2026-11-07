import { basename, isAbsolute, resolve } from 'node:path';
import { isHookConvertible } from './supported';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleClaudePreToolUse(
  payload: unknown,
  convert: (absPath: string) => Promise<string>,
): Promise<object | null> {
  try {
    if (!isRecord(payload) || payload.tool_name !== 'Read' || !isRecord(payload.tool_input)) return null;
    const toolInput = payload.tool_input;
    if (toolInput.pages !== undefined || typeof toolInput.file_path !== 'string') return null;
    if (!isHookConvertible(toolInput.file_path)) return null;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const original = isAbsolute(toolInput.file_path) ? toolInput.file_path : resolve(cwd, toolInput.file_path);
    const mdPath = await convert(original);
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
