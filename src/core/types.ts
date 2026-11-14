export type LocalBoosterId = 'dedupe' | 'media' | 'tables' | 'ws';
export type BoosterId = LocalBoosterId | 'lingua';
export interface BoosterMeta { id: BoosterId; name: string; hint: string; lossy: boolean; estimate: number }
export type FileKind = 'PDF' | 'DOCX' | 'PPTX' | 'XLSX' | 'ODF' | 'IMG';
export type ErrorCode = 'unsupported_type' | 'needs_libreoffice' | 'too_large' | 'password_protected' | 'timeout' | 'parse_failed' | 'bad_request' | 'not_found' | 'lingua_unavailable' | 'forbidden';
export interface ApiError { code: ErrorCode; message: string }
export interface ParseResponse { id: string; name: string; kind: FileKind; pages: number; markdown: string; ms: number }
export type LinguaModel = 'tinybert' | 'mobilebert' | 'xlm-roberta';
export type LinguaInstallErrorCode = 'npm_missing' | 'npm_failed' | 'timeout' | 'verify_failed' | 'filesystem' | 'unsupported_platform';
export interface LinguaInstallError { code: LinguaInstallErrorCode; message: string }
export interface LinguaStatus {
  installed: boolean;
  installable: boolean;
  model: LinguaModel;
  state: 'idle' | 'downloading' | 'ready' | 'error' | 'installing' | 'install_failed';
  progress: number;
  installError?: LinguaInstallError;
  unsupportedReason?: string;
  modelError?: string;
}
export interface Health { version: string; liteparseVersion: string; libreoffice: boolean; lingua: LinguaStatus; maxBytes: number }
export interface DistillResult { path: string; name: string; kind: FileKind; pages: number; markdown: string; tokens: { raw: number; out: number }; ms: number }
export type InstallMethod = 'npm-global' | 'npx' | 'docker' | 'desktop' | 'source';
export interface UpdateCheck { current: string; latest: string | null; available: boolean; method: InstallMethod; enabled: boolean; disabledBy: 'env' | 'setting' | null; checkedAt: string | null }
export interface UpdateInstallStatus { state: 'idle' | 'running' | 'done' | 'failed'; version?: string; error?: string }
export interface UpdateInfo extends UpdateCheck { canInstall: boolean; install: UpdateInstallStatus }
