export const CLAUDE_ALLOW_RULE = 'Read(~/.cache/distillmd/out/**)';
const HOOK_TIMEOUT_SECONDS = 120;

export interface Plan {
  next: string;
  changed: boolean;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSettings(current: string | null): Json {
  if (current === null || current.trim() === '') return {};
  const parsed: unknown = JSON.parse(current);
  if (!isObject(parsed)) throw new Error('the top-level value is not an object');
  return parsed;
}

function serialize(settings: Json): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function isOwnCommand(command: unknown): boolean {
  return typeof command === 'string' && /distill(md|-llm)/.test(command) && /hook claude\s*$/.test(command);
}

function isOwnHook(hook: unknown): boolean {
  return isObject(hook) && isOwnCommand(hook.command);
}

function entryHooks(entry: unknown): unknown[] {
  return isObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
}

export function normalizeSettings(current: string): string {
  return current.trim() === '' ? '' : serialize(parseSettings(current));
}

export function planClaudeInstall(current: string | null, command: string): Plan {
  const settings = parseSettings(current);
  let changed = false;

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const wanted = `${command} hook claude`;
  const own = preToolUse.flatMap((entry) => entryHooks(entry).filter(isOwnHook)) as Json[];
  if (own.length > 0) {
    for (const hook of own) {
      if (hook.command !== wanted) {
        hook.command = wanted;
        changed = true;
      }
    }
  } else {
    preToolUse.push({
      matcher: 'Read',
      hooks: [{ type: 'command', command: `${command} hook claude`, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    changed = true;
  }

  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (!allow.includes(CLAUDE_ALLOW_RULE)) {
    allow.push(CLAUDE_ALLOW_RULE);
    permissions.allow = allow;
    settings.permissions = permissions;
    changed = true;
  }

  if (!changed) return { next: current ?? serialize(settings), changed: false };
  return { next: serialize(settings), changed: true };
}

export function planClaudeUninstall(current: string): Plan {
  const settings = parseSettings(current);
  let changed = false;

  if (isObject(settings.hooks) && Array.isArray(settings.hooks.PreToolUse)) {
    const kept: unknown[] = [];
    for (const entry of settings.hooks.PreToolUse) {
      const inner = entryHooks(entry);
      const remaining = inner.filter((hook) => !isOwnHook(hook));
      if (remaining.length === inner.length) {
        kept.push(entry);
        continue;
      }
      changed = true;
      if (remaining.length > 0) kept.push({ ...(entry as Json), hooks: remaining });
    }
    if (changed) {
      if (kept.length > 0) settings.hooks.PreToolUse = kept;
      else delete settings.hooks.PreToolUse;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
  }

  if (isObject(settings.permissions) && Array.isArray(settings.permissions.allow)) {
    const remaining = settings.permissions.allow.filter((rule) => rule !== CLAUDE_ALLOW_RULE);
    if (remaining.length !== settings.permissions.allow.length) {
      changed = true;
      if (remaining.length > 0) settings.permissions.allow = remaining;
      else delete settings.permissions.allow;
      if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
    }
  }

  return changed ? { next: serialize(settings), changed: true } : { next: current, changed: false };
}
