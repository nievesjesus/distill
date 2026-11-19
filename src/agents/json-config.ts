import { normalizeSettings } from '../hooks/install-claude';
import type { Plan } from '../hooks/install-claude';
import type { Step } from './types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoot(current: string | null): Json {
  if (current === null || current.trim() === '') return {};
  const parsed: unknown = JSON.parse(current);
  if (!isObject(parsed)) throw new Error('the top-level value is not an object');
  return parsed;
}

function serialize(root: Json): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

function isOwnServer(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('distill-llm');
}

function find(root: Json, path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

export function serverState(current: string | null, path: string[]): 'none' | 'own' | 'foreign' {
  const found = find(parseRoot(current), path);
  if (found === undefined) return 'none';
  return isOwnServer(found) ? 'own' : 'foreign';
}

export function planServerInstall(current: string | null, path: string[], entry: unknown): Plan {
  const root = parseRoot(current);
  const name = path[path.length - 1] as string;
  let container = root;
  for (const key of path.slice(0, -1)) {
    const next = container[key];
    if (isObject(next)) container = next;
    else {
      const created: Json = {};
      container[key] = created;
      container = created;
    }
  }
  const existing = container[name];
  if (existing !== undefined && !isOwnServer(existing)) {
    throw new Error(`${path.join('.')} already exists and was not created by distill; refusing to overwrite it`);
  }
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { next: current ?? serialize(root), changed: false };
  }
  container[name] = entry;
  return { next: serialize(root), changed: true };
}

export function planServerRemove(current: string, path: string[]): Plan {
  const root = parseRoot(current);
  const chain: Json[] = [root];
  for (const key of path.slice(0, -1)) {
    const next = (chain[chain.length - 1] as Json)[key];
    if (!isObject(next)) return { next: current, changed: false };
    chain.push(next);
  }
  const name = path[path.length - 1] as string;
  const container = chain[chain.length - 1] as Json;
  if (container[name] === undefined || !isOwnServer(container[name])) return { next: current, changed: false };
  delete container[name];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (Object.keys(chain[index] as Json).length > 0) break;
    delete (chain[index - 1] as Json)[path[index - 1] as string];
  }
  return { next: serialize(root), changed: true };
}

export function jsonFileStep(path: string, current: string | null, plan: Plan): Step {
  const before = current === null ? null : normalizeSettings(current);
  const note = before !== null && before !== current && current?.trim() !== '' ? `Note: ${path} will be re-indented with 2 spaces.` : undefined;
  return { kind: 'file', path, before, next: plan.next, note };
}

export function parseFailure(path: string, error: unknown): Error {
  return new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
}

export function textServerState(text: string | null, key: RegExp): 'none' | 'own' | 'foreign' {
  if (text === null || !key.test(text)) return 'none';
  return text.includes('distill-llm') ? 'own' : 'foreign';
}

export function commandParts(command: string, extra: string[]): { bin: string; args: string[] } {
  const [bin, ...rest] = command.split(' ');
  return { bin: bin as string, args: [...rest, ...extra] };
}

export function displayCommand(bin: string, args: string[]): string {
  return [bin, ...args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

export function execStep(bin: string, args: string[]): Step {
  return { kind: 'exec', bin, args, display: displayCommand(bin, args) };
}
