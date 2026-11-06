import type { FileKind } from './types';

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  pdf: 'PDF',
  docx: 'DOCX',
  doc: 'DOCX',
  pptx: 'PPTX',
  ppt: 'PPTX',
  xlsx: 'XLSX',
  xls: 'XLSX',
  csv: 'XLSX',
  odt: 'ODF',
  ods: 'ODF',
  odp: 'ODF',
  png: 'IMG',
  jpg: 'IMG',
  jpeg: 'IMG',
  tif: 'IMG',
  tiff: 'IMG',
  webp: 'IMG',
};

const OFFICE_KINDS: ReadonlySet<FileKind> = new Set(['DOCX', 'PPTX', 'XLSX', 'ODF']);

export function detectKind(filename: string): FileKind | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return KIND_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}

export function needsLibreOffice(kind: FileKind): boolean {
  return OFFICE_KINDS.has(kind);
}
