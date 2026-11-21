import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { AsrStatus } from '../core/types';
import { findOnPath } from '../hooks/command';
import { AsrError } from './asr/errors';
import { ASR_MODELS, ASR_MODEL_NAMES, DEFAULT_ASR_MODEL, isAsrModelName } from './asr/models';
import type { AsrModelName } from './asr/models';
import { RENAME_BACKOFF_MS, createRuntimeInstaller, renameWithRetry } from './runtime-install';
import type { FileOps } from './runtime-install';
import type { RuntimeInstallerOptions } from './runtime-install';

export const ASR_MODEL_ID = ASR_MODELS.parakeet.id;

const RUNTIME_PACKAGE = 'sherpa-onnx-node';
export const ASR_RUNTIME_VERSION = '2.0.2';
const RUNTIME_DIR = 'asr';
const MODELS_DIR = 'asr-models';
const VAD_FILE = 'silero_vad.onnx';
const DEFAULT_FILE = 'default';

export interface AsrFile {
  name: string;
  dir: 'model' | 'vad';
  url: string;
  size: number;
  sha256: string;
}

const VAD_ENTRY: AsrFile = {
  name: VAD_FILE,
  dir: 'vad',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  size: 643854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
};

export function asrFilesFor(model: AsrModelName): readonly AsrFile[] {
  return [...ASR_MODELS[model].files.map((file): AsrFile => ({ ...file, dir: 'model' })), VAD_ENTRY];
}

export const ASR_FILES: readonly AsrFile[] = asrFilesFor('parakeet');

export function asrDownloadBytes(model: AsrModelName): number {
  return asrFilesFor(model).reduce((sum, file) => sum + file.size, 0);
}

export const ASR_RUNTIME_APPROX_BYTES = 35_000_000;
export const ASR_MODELS_BYTES = ASR_FILES.reduce((sum, file) => sum + file.size, 0);

const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': 'sherpa-onnx-darwin-arm64',
  'darwin-x64': 'sherpa-onnx-darwin-x64',
  'linux-x64': 'sherpa-onnx-linux-x64',
  'linux-arm64': 'sherpa-onnx-linux-arm64',
  'win32-x64': 'sherpa-onnx-win-x64',
  'win32-ia32': 'sherpa-onnx-win-ia32',
  'win32-arm64': 'sherpa-onnx-win-arm64',
};

export function asrPlatformPackage(platform: string, arch: string): string | undefined {
  return PLATFORM_PACKAGES[`${platform}-${arch}`];
}

export function asrPaths(cacheDir: string, model: AsrModelName = DEFAULT_ASR_MODEL): { runtimeRoot: string; modelDir: string; vadPath: string; defaultPath: string } {
  return {
    runtimeRoot: join(cacheDir, RUNTIME_DIR),
    modelDir: join(cacheDir, MODELS_DIR, ASR_MODELS[model].id),
    vadPath: join(cacheDir, MODELS_DIR, VAD_FILE),
    defaultPath: join(cacheDir, MODELS_DIR, DEFAULT_FILE),
  };
}

export function readDefaultModel(cacheDir: string): AsrModelName | undefined {
  try {
    const value = readFileSync(asrPaths(cacheDir).defaultPath, 'utf8').trim();
    return isAsrModelName(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface SelectAsrModelOptions {
  cacheDir: string;
  env: Record<string, string | undefined>;
  requested?: string;
}

function checkedModel(value: string, source: string): AsrModelName {
  if (isAsrModelName(value)) return value;
  throw new AsrError('asr_unavailable', `Unknown speech model "${value}" (${source}). Choose one of: ${ASR_MODEL_NAMES.join(', ')}.`);
}

export function selectAsrModel(options: SelectAsrModelOptions): AsrModelName {
  const fromEnv = options.env.DISTILL_ASR_MODEL?.trim();
  if (fromEnv) return checkedModel(fromEnv, 'DISTILL_ASR_MODEL');
  if (options.requested) return checkedModel(options.requested, '--asr-model');
  return readDefaultModel(options.cacheDir) ?? DEFAULT_ASR_MODEL;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveFfmpeg(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string | null {
  const own = env.DISTILL_FFMPEG?.trim();
  if (own && isAbsolute(own) && isRegularFile(own)) return own;
  return findOnPath(platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', env.PATH ?? env.Path, platform);
}

export type { AsrStatus };

export interface AsrProgress {
  file: string;
  done: number;
  total: number;
}

export interface AsrInstallOptions {
  onProgress?: (progress: AsrProgress) => void;
  signal?: AbortSignal;
  model?: AsrModelName;
}

export interface AsrInstaller {
  status(model?: AsrModelName): AsrStatus;
  install(options?: AsrInstallOptions): Promise<void>;
  uninstall(model?: AsrModelName): Promise<void>;
}

export type AsrInstallErrorCode = 'unsupported_platform' | 'download_failed' | 'size_mismatch' | 'sha_mismatch' | 'aborted';

export class AsrInstallFailure extends Error {
  constructor(
    readonly code: AsrInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AsrInstallFailure';
  }
}

export interface AsrStatusOptions {
  cacheDir: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform | string;
  arch?: string;
  files?: readonly AsrFile[];
  modelFiles?: Partial<Record<AsrModelName, readonly AsrFile[]>>;
  model?: AsrModelName;
}

export interface AsrInstallerOptions
  extends AsrStatusOptions,
    Pick<RuntimeInstallerOptions, 'runtimeDir' | 'fileOps' | 'spawn' | 'resolveNpm' | 'timeoutMs' | 'killGraceMs' | 'renameBackoffMs'> {
  fetch?: typeof globalThis.fetch;
}

function unsupportedReason(platform: string, arch: string): string | undefined {
  return asrPlatformPackage(platform, arch) === undefined
    ? `Speech recognition has no prebuilt runtime for ${platform}-${arch}.`
    : undefined;
}

function runtimePackages(platform: string, arch: string): string[] {
  const platformPackage = asrPlatformPackage(platform, arch);
  return platformPackage === undefined ? [RUNTIME_PACKAGE] : [RUNTIME_PACKAGE, platformPackage];
}

function fileTarget(cacheDir: string, file: AsrFile, model: AsrModelName): string {
  const paths = asrPaths(cacheDir, model);
  return file.dir === 'vad' ? paths.vadPath : join(paths.modelDir, file.name);
}

function hasFileOfSize(path: string, size: number): boolean {
  try {
    return statSync(path).size === size;
  } catch {
    return false;
  }
}

function installedVersion(root: string, name: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function runtimePresent(cacheDir: string, platform: string, arch: string): boolean {
  const root = asrPaths(cacheDir).runtimeRoot;
  const present = runtimePackages(platform, arch).every((name) => existsSync(join(root, 'node_modules', ...name.split('/'), 'package.json')));
  return present && installedVersion(root, RUNTIME_PACKAGE) === ASR_RUNTIME_VERSION;
}

function treeBytes(path: string): number {
  let entries: string[];
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size;
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  return entries.reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}

export function getAsrStatus(options: AsrStatusOptions): AsrStatus {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const persisted = readDefaultModel(options.cacheDir);
  const target = options.model ?? persisted ?? DEFAULT_ASR_MODEL;
  const filesOf = (model: AsrModelName): readonly AsrFile[] => options.modelFiles?.[model] ?? (options.files && model === target ? options.files : asrFilesFor(model));
  const present = (model: AsrModelName, only?: AsrFile['dir']) =>
    filesOf(model).filter((file) => only === undefined || file.dir === only).every((file) => hasFileOfSize(fileTarget(options.cacheDir, file, model), file.size));
  const reason = unsupportedReason(platform, arch);
  const runtime = reason === undefined && runtimePresent(options.cacheDir, platform, arch);
  const models = present(target);
  const installedModels = ASR_MODEL_NAMES.filter((model) => present(model, 'model')).map((model) => ({
    name: model,
    bytes: filesOf(model).filter((file) => file.dir === 'model').reduce((sum, file) => sum + file.size, 0),
  }));
  const paths = asrPaths(options.cacheDir);
  return {
    installed: runtime && models,
    runtime,
    models,
    vad: present(target, 'vad'),
    model: target,
    defaultModel: persisted ?? null,
    installedModels,
    ffmpeg: resolveFfmpeg(env, platform as NodeJS.Platform),
    installable: reason === undefined,
    ...(reason === undefined ? {} : { unsupportedReason: reason }),
    diskBytes: treeBytes(paths.runtimeRoot) + treeBytes(join(options.cacheDir, MODELS_DIR)),
  };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function partSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function abortFailure(file: AsrFile): AsrInstallFailure {
  return new AsrInstallFailure('aborted', `Download of ${file.name} was cancelled`);
}

export function createAsrInstaller(options: AsrInstallerOptions): AsrInstaller {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const filesFor = (model: AsrModelName): readonly AsrFile[] => options.modelFiles?.[model] ?? options.files ?? asrFilesFor(model);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const paths = asrPaths(options.cacheDir);
  const reason = unsupportedReason(platform, arch);
  let running: Promise<void> | undefined;
  let runningModel: AsrModelName | undefined;

  async function installRuntime(): Promise<void> {
    if (runtimePresent(options.cacheDir, platform, arch)) return;
    const installer = createRuntimeInstaller({
      cacheDir: options.cacheDir,
      runtimeDir: options.runtimeDir,
      installDir: RUNTIME_DIR,
      packages: runtimePackages(platform, arch),
      label: 'speech recognition',
      fileOps: options.fileOps,
      spawn: options.spawn,
      resolveNpm: options.resolveNpm,
      timeoutMs: options.timeoutMs,
      killGraceMs: options.killGraceMs,
      renameBackoffMs: options.renameBackoffMs,
    });
    await installer.install();
  }

  const ops: FileOps = { rename, rm, ...options.fileOps };
  const backoffMs = options.renameBackoffMs ?? RENAME_BACKOFF_MS;

  const writeChunk = (stream: WriteStream, chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => stream.write(chunk, (error) => (error ? reject(error) : resolve())));
  const closeStream = (stream: WriteStream) => new Promise<void>((resolve) => stream.end(() => resolve()));

  interface Job {
    model: AsrModelName;
    total: number;
  }

  async function download(file: AsrFile, before: number, install: AsrInstallOptions, job: Job, restarted = false): Promise<void> {
    const target = fileTarget(options.cacheDir, file, job.model);
    const part = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    let have = await partSize(part);
    if (have > file.size) {
      await rm(part, { force: true });
      have = 0;
    }
    const emit = (done: number) => install.onProgress?.({ file: file.name, done: before + done, total: job.total });
    emit(have);
    if (have === file.size) {
      if ((await sha256Of(part)) === file.sha256) {
        await renameWithRetry(ops, part, target, backoffMs);
        return;
      }
      await rm(part, { force: true });
      return download(file, before, install, job, restarted);
    }
    let response: Response;
    try {
      response = await fetchFn(file.url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        signal: install.signal,
        redirect: 'follow',
      });
    } catch (error) {
      if (install.signal?.aborted) throw abortFailure(file);
      throw new AsrInstallFailure('download_failed', `Could not download ${file.name}: ${(error as Error).message}`);
    }
    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      await rm(part, { force: true });
      if (!restarted) return download(file, before, install, job, true);
      throw new AsrInstallFailure('download_failed', `Could not resume ${file.name}: the server rejected the range. Try again.`);
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new AsrInstallFailure('download_failed', `Could not download ${file.name}: HTTP ${response.status}`);
    }
    if (!response.body) throw new AsrInstallFailure('download_failed', `Could not download ${file.name}: empty response`);
    if (response.status === 200 || have === 0) have = 0;
    let written = have;
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    out.on('error', () => undefined);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > file.size) {
          await reader.cancel().catch(() => undefined);
          await closeStream(out);
          await rm(part, { force: true });
          throw new AsrInstallFailure('size_mismatch', `${file.name} is larger than the expected ${file.size} bytes`);
        }
        await writeChunk(out, value);
        emit(written);
      }
    } catch (error) {
      await closeStream(out);
      if (error instanceof AsrInstallFailure) throw error;
      if (install.signal?.aborted) throw abortFailure(file);
      throw new AsrInstallFailure('download_failed', `Download of ${file.name} was interrupted: ${(error as Error).message}`);
    }
    await closeStream(out);
    if (written !== file.size) {
      await rm(part, { force: true });
      throw new AsrInstallFailure('size_mismatch', `${file.name} ended at ${written} bytes, expected ${file.size}`);
    }
    if ((await sha256Of(part)) !== file.sha256) {
      await rm(part, { force: true });
      throw new AsrInstallFailure('sha_mismatch', `${file.name} failed the sha256 check`);
    }
    await renameWithRetry(ops, part, target, backoffMs);
  }

  async function perform(install: AsrInstallOptions): Promise<void> {
    if (reason) throw new AsrInstallFailure('unsupported_platform', reason);
    const model = install.model ?? DEFAULT_ASR_MODEL;
    const files = filesFor(model);
    const job: Job = { model, total: files.reduce((sum, file) => sum + file.size, 0) };
    await installRuntime();
    let before = 0;
    for (const file of files) {
      if (!hasFileOfSize(fileTarget(options.cacheDir, file, model), file.size)) await download(file, before, install, job);
      before += file.size;
    }
    await mkdir(dirname(paths.defaultPath), { recursive: true });
    await writeFile(paths.defaultPath, `${model}\n`);
  }

  function modelInstalled(model: AsrModelName): boolean {
    return filesFor(model).filter((file) => file.dir === 'model').every((file) => hasFileOfSize(fileTarget(options.cacheDir, file, model), file.size));
  }

  return {
    status: (model) => getAsrStatus({ cacheDir: options.cacheDir, env: options.env, platform, arch, files: options.files, modelFiles: options.modelFiles, ...(model ? { model } : {}) }),
    install(install = {}) {
      const model = install.model ?? DEFAULT_ASR_MODEL;
      if (running && runningModel === model) return running;
      const previous = running ?? Promise.resolve();
      const current: Promise<void> = previous
        .catch(() => undefined)
        .then(() => perform(install))
        .finally(() => {
          if (running === current) {
            running = undefined;
            runningModel = undefined;
          }
        });
      running = current;
      runningModel = model;
      return current;
    },
    async uninstall(model) {
      if (model === undefined) {
        await rm(paths.runtimeRoot, { recursive: true, force: true });
        await rm(join(options.cacheDir, MODELS_DIR), { recursive: true, force: true });
        return;
      }
      await rm(asrPaths(options.cacheDir, model).modelDir, { recursive: true, force: true });
      if (readDefaultModel(options.cacheDir) !== model) return;
      const next = ASR_MODEL_NAMES.find((name) => name !== model && modelInstalled(name));
      if (next) await writeFile(paths.defaultPath, `${next}\n`);
      else await rm(paths.defaultPath, { force: true });
    },
  };
}
