import { detectKind } from '../core/kind';

const HOOK_KINDS: ReadonlySet<string> = new Set(['PDF', 'DOCX', 'PPTX', 'XLSX', 'ODF']);
const EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set(['csv']);

export function isHookConvertible(path: string): boolean {
  const kind = detectKind(path);
  if (kind === null || !HOOK_KINDS.has(kind)) return false;
  return !EXCLUDED_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
}
