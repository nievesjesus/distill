import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { buildOutline, figurePagesIn, fitLines, pageMarkersIn, renderOutline } from '../core/outline';
import { type SavingsEstimate, estimateSavings, savingsNote } from '../core/savings';
import { countTokens } from '../core/tokens';
import { isInside } from '../node/inside';
import { isOwnCommand } from './install-claude';
import { type MatchContext, type ReadRule, parseReadRule, ruleMayMatch } from './read-rules';
import { detectKind } from '../core/kind';
import { isHookConvertible } from './supported';

export interface ClaudeHookDeps {
  homeDir: string;
  cacheDir?: string;
  projectDir?: string;
  managedSettingsPaths?: string[];
  platform?: NodeJS.Platform;
  plugin?: boolean;
  savingsNote?: boolean;
  recordUsage?: (path: string, savings: SavingsEstimate) => void;
  indexMinTokens?: number;
  asrInstalled?: () => boolean;
  mediaGate?: (absPath: string) => Promise<'convert' | { defer: string }>;
}

const SPEECH_ERROR_CODES: ReadonlySet<string> = new Set(['asr_unavailable', 'ffmpeg_missing', 'no_audio', 'asr_failed', 'timeout', 'aborted']);

const DEFAULT_INDEX_MIN_TOKENS = 8000;
const FIRST_PART_TOKENS = 2000;

function figureNote(pages: string[]): string {
  const first = pages[0];
  if (first === undefined) return '';
  if (pages.length === 1) {
    return `\nPage ${first} contains a chart or image that is not in this Markdown. If the question depends on it, Read the original with pages: "${first}".`;
  }
  const list = `${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`;
  return `\nPages ${list} contain charts or images that are not in this Markdown. If the question depends on them, Read the original with pages: "${first}".`;
}

const MAX_PAGE_SPAN = 5000;
const PAGE_NUMBER = /^\d+$/;

function parsePages(spec: unknown): string[] | null {
  if (typeof spec !== 'string') return null;
  const labels: string[] = [];
  for (const part of spec.split(',')) {
    const text = part.replace(/\s+/g, '');
    const range = /^(\d+)-(\d+)$/.exec(text);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from >= MAX_PAGE_SPAN) return null;
      for (let page = from; page <= to; page++) labels.push(String(page));
    } else if (PAGE_NUMBER.test(text)) {
      labels.push(String(Number(text)));
    } else {
      return null;
    }
    if (labels.length > MAX_PAGE_SPAN) return null;
  }
  return labels.length === 0 ? null : [...new Set(labels)];
}

interface PageSlice {
  from: number;
  to: number;
  text: string;
  figures: string[];
  count: number;
}

function sliceOfPages(markdown: string, physical: string[]): PageSlice | null {
  const lines = markdown.split('\n');
  const markers = pageMarkersIn(markdown);
  if (markers.length === 0) return { from: 1, to: lines.length, text: markdown, figures: [], count: physical.length };
  const indexes: number[] = [];
  for (const label of physical) {
    const index = Number(label) - 1;
    if (index >= markers.length) return null;
    indexes.push(index);
  }
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  const from = markers[first].line;
  const to = last + 1 < markers.length ? markers[last + 1].line - 1 : lines.length;
  const figures = indexes.filter((index) => markers[index].visual === 'figure').map((index) => String(index + 1));
  if (figures.length === indexes.length) return null;
  return { from, to, text: lines.slice(from - 1, to).join('\n'), figures, count: physical.length };
}

function asrMissingContext(name: string, original: string): string {
  return `distill can transcribe ${name} locally to save tokens, but speech recognition is not installed, so this read was not converted. To enable it, run \`distill-llm asr install\` once (about 700 MB), then read ${original} again.`;
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

async function hasOwnHook(file: SettingsFile): Promise<boolean> {
  try {
    const settings: unknown = JSON.parse(await readFile(file.path, 'utf8'));
    if (!isRecord(settings) || !isRecord(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return false;
    return settings.hooks.PreToolUse.some(
      (entry) =>
        isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => isRecord(hook) && isOwnCommand(hook.command)),
    );
  } catch {
    return false;
  }
}

async function anyOwnHook(files: SettingsFile[]): Promise<boolean> {
  return (await Promise.all(files.map(hasOwnHook))).some(Boolean);
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
  convert: (absPath: string) => Promise<{ path: string; savings?: SavingsEstimate; markdown?: string }>,
  deps: ClaudeHookDeps,
): Promise<object | null> {
  try {
    if (!isRecord(payload) || payload.tool_name !== 'Read' || !isRecord(payload.tool_input)) return null;
    const toolInput = payload.tool_input;
    if (typeof toolInput.file_path !== 'string') return null;
    const pageLabels = toolInput.pages === undefined ? null : parsePages(toolInput.pages);
    if (toolInput.pages !== undefined && pageLabels === null) return null;
    if (!isHookConvertible(toolInput.file_path)) return null;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const original = isAbsolute(toolInput.file_path) ? toolInput.file_path : resolve(cwd, toolInput.file_path);
    const [realOriginal, realCwd, realProject] = await Promise.all([realpath(original), realpath(cwd), realpathOrNull(deps.projectDir)]);
    if (!isInside(realOriginal, realCwd) && !(realProject !== null && isInside(realOriginal, realProject))) return null;
    const ctx: MatchContext = { cwd: realCwd, home: deps.homeDir, platform: deps.platform ?? process.platform };
    const candidates = [original, realOriginal, join(deps.cacheDir ?? join(deps.homeDir, '.cache', 'distill-llm'), 'out', 'probe.md')];
    const files = settingsFiles(realCwd, realProject, deps);
    if (await anyReadRestriction(files, candidates, ctx)) return null;
    if (deps.plugin === true && (await anyOwnHook(files))) return null;
    const mediaKind = detectKind(original);
    if ((mediaKind === 'AUDIO' || mediaKind === 'VIDEO') && deps.asrInstalled?.() === false) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: asrMissingContext(basename(original), original) } };
    }
    const isMedia = mediaKind === 'AUDIO' || mediaKind === 'VIDEO';
    if (isMedia && deps.mediaGate !== undefined) {
      const plan = await deps.mediaGate(realOriginal);
      if (plan !== 'convert') return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: plan.defer } };
    }
    let converted: Awaited<ReturnType<typeof convert>>;
    try {
      converted = await convert(realOriginal);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (isMedia && typeof code === 'string' && SPEECH_ERROR_CODES.has(code) && error instanceof Error) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `distill could not transcribe ${basename(original)}, so this read was not converted: ${error.message}` } };
      }
      throw error;
    }
    if (pageLabels !== null) {
      if (converted.markdown === undefined) return null;
      const slice = sliceOfPages(converted.markdown, pageLabels);
      if (slice === null) return null;
      const { pages: _pages, ...rest } = toolInput;
      const spec = String(toolInput.pages).trim();
      const tokens = countTokens(slice.text);
      const savings = estimateSavings({ kind: 'PDF', pages: slice.count, tokens: { raw: tokens, out: tokens } });
      try {
        deps.recordUsage?.(original, savings);
      } catch {}
      const note = deps.savingsNote !== false ? `\n${savingsNote(savings)}` : '';
      const limit = slice.to - slice.from + 1;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...rest, file_path: converted.path, offset: slice.from, limit },
          permissionDecision: 'allow',
          permissionDecisionReason: 'distill: converted copy in its cache',
          additionalContext: `distill converted pages ${spec} of ${basename(original)} to Markdown (lines ${slice.from}-${slice.to} of the converted document). Original file: ${original}.${figureNote(slice.figures)}${note}`,
        },
      };
    }
    const paged = toolInput.offset !== undefined || toolInput.limit !== undefined;
    let note = '';
    const figures = !paged && converted.markdown !== undefined ? figureNote(figurePagesIn(converted.markdown)) : '';
    if (!paged && converted.savings !== undefined) {
      try {
        deps.recordUsage?.(original, converted.savings);
      } catch {}
      if (deps.savingsNote !== false) note = `\n${savingsNote(converted.savings)}`;
    }
    const lead = `distill converted ${basename(original)} to Markdown to save tokens. Original file: ${original}.${figures}`;
    const indexMin = deps.indexMinTokens ?? DEFAULT_INDEX_MIN_TOKENS;
    const markdown = converted.markdown;
    if (!paged && markdown !== undefined && indexMin > 0) {
      const tokens = countTokens(markdown);
      if (tokens > indexMin) {
        const limit = fitLines(markdown, FIRST_PART_TOKENS);
        const lines = markdown.split('\n').length;
        const index = renderOutline(buildOutline(markdown), { name: basename(original) });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { ...toolInput, file_path: converted.path, offset: 1, limit },
            permissionDecision: 'allow',
            permissionDecisionReason: 'distill: converted copy in its cache',
            additionalContext: `${lead} This is a large document: ${lines} lines, ~${tokens} tokens. Only lines 1-${limit} were loaded. To find a word or number, search with distill_search. Read the sections you need with Read on ${original} using offset and limit (for a PDF, pages works too) from this index:\n${index}${note}`,
          },
        };
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...toolInput, file_path: converted.path },
        permissionDecision: 'allow',
        permissionDecisionReason: 'distill: converted copy in its cache',
        additionalContext: `${lead}${note}`,
      },
    };
  } catch {
    return null;
  }
}
