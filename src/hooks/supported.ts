import { detectKind } from '../core/kind';

const HOOK_KINDS: ReadonlySet<string> = new Set(['PDF', 'DOCX', 'PPTX', 'XLSX', 'ODF']);

export function isHookConvertible(path: string): boolean {
  const kind = detectKind(path);
  return kind !== null && HOOK_KINDS.has(kind);
}
