export interface ReadRule {
  spec: string | null;
  root: string | null;
}

export interface MatchContext {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
}

export function parseReadRule(rule: string, root: string | null): ReadRule | null {
  if (rule === 'Read') return { spec: null, root };
  if (rule.startsWith('Read(')) {
    const inner = rule.slice('Read('.length);
    return { spec: inner.endsWith(')') ? inner.slice(0, -1) : inner, root };
  }
  if (rule.startsWith('Read')) return { spec: null, root };
  return null;
}

const toSlashes = (value: string): string => value.replace(/\\/g, '/');

const trimTrailingSlash = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, '') : value);

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^$()|\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
}

function ancestorsOf(path: string): string[] {
  const result = [path];
  let current = path;
  for (;;) {
    const idx = current.lastIndexOf('/');
    if (idx <= 0) break;
    current = current.slice(0, idx);
    if (/^[a-z]:$/i.test(current)) break;
    result.push(current);
  }
  return result;
}

function join(base: string, rest: string): string {
  return `${trimTrailingSlash(base)}/${rest}`;
}

export function ruleMayMatch(rule: ReadRule, absPath: string, ctx: MatchContext): boolean {
  const win = ctx.platform === 'win32';
  const spec = rule.spec;
  if (spec === null || spec === '' || spec === '*' || spec === '**') return true;
  if (/[[\]{}!]/.test(spec)) return true;
  if (!win && spec.includes('\\')) return true;

  const insensitive = win || ctx.platform === 'darwin';
  const norm = (value: string): string => {
    const slashed = toSlashes(value);
    return insensitive ? slashed.toLowerCase() : slashed;
  };

  const text = norm(spec);
  let pattern: string;
  let basenameToo = false;

  if (text.startsWith('//')) {
    const rest = text.slice(2);
    const drive = win ? /^([a-z])\/(.*)$/.exec(rest) : null;
    pattern = drive ? `${drive[1]}:/${drive[2]}` : `/${rest}`;
  } else if (text.startsWith('~/')) {
    pattern = join(norm(ctx.home), text.slice(2));
  } else if (text.startsWith('/')) {
    if (rule.root === null) return true;
    pattern = join(norm(rule.root), text.slice(1));
  } else {
    const rest = text.startsWith('./') ? text.slice(2) : text;
    pattern = join(norm(ctx.cwd), rest);
    basenameToo = !rest.includes('/');
  }

  const full = globToRegExp(trimTrailingSlash(pattern));
  const base = basenameToo ? globToRegExp(text.startsWith('./') ? text.slice(2) : text) : null;

  return ancestorsOf(trimTrailingSlash(norm(absPath))).some((candidate) => {
    if (full.test(candidate)) return true;
    if (base === null) return false;
    return base.test(candidate.slice(candidate.lastIndexOf('/') + 1));
  });
}
