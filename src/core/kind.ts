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

const LEGACY_OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(['doc', 'xls', 'ppt', 'odt', 'ods', 'odp']);

export function detectKind(filename: string): FileKind | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return KIND_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}

export function needsLibreOfficeFor(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return LEGACY_OFFICE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
