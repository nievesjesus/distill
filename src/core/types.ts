export type LocalBoosterId = 'dedupe' | 'media' | 'tables' | 'ws';
export type BoosterId = LocalBoosterId | 'lingua';
export interface BoosterMeta { id: BoosterId; name: string; hint: string; lossy: boolean; estimate: number }
export type FileKind = 'PDF' | 'DOCX' | 'PPTX' | 'XLSX' | 'ODF' | 'IMG';
export type ErrorCode = 'unsupported_type' | 'needs_libreoffice' | 'too_large' | 'password_protected' | 'timeout' | 'parse_failed' | 'bad_request' | 'not_found' | 'lingua_unavailable' | 'forbidden';
export interface ApiError { code: ErrorCode; message: string }
export interface ParseResponse { id: string; name: string; kind: FileKind; pages: number; markdown: string; ms: number }
export type LinguaModel = 'tinybert' | 'mobilebert' | 'xlm-roberta';
export interface LinguaStatus { installed: boolean; model: LinguaModel; state: 'idle' | 'downloading' | 'ready' | 'error'; progress: number }
export interface Health { version: string; liteparseVersion: string; libreoffice: boolean; lingua: LinguaStatus; maxBytes: number }
