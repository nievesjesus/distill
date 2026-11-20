import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { AsrStatus } from '../core/types';
import { findOnPath } from '../hooks/command';
import { RENAME_BACKOFF_MS, createRuntimeInstaller, renameWithRetry } from './runtime-install';
import type { FileOps } from './runtime-install';
import type { RuntimeInstallerOptions } from './runtime-install';

export const ASR_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8';

const MODEL_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const MODEL_COMMIT = 'ed5d745623472f97cfc2e6c2916ee248798fc5a8';
const RUNTIME_PACKAGE = 'sherpa-onnx-node';
export const ASR_RUNTIME_VERSION = '2.0.2';
const RUNTIME_DIR = 'asr';
const MODELS_DIR = 'asr-models';
const VAD_FILE = 'silero_vad.onnx';

export interface AsrFile {
  name: string;
  dir: 'model' | 'vad';
  url: string;
  size: number;
  sha256: string;
}

const modelUrl = (name: string) => `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_COMMIT}/${name}`;

export const ASR_FILES: readonly AsrFile[] = [
  { name: 'encoder.int8.onnx', dir: 'model', url: modelUrl('encoder.int8.onnx'), size: 652282294, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479' },
  { name: 'decoder.int8.onnx', dir: 'model', url: modelUrl('decoder.int8.onnx'), size: 11845274, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5' },
  { name: 'joiner.int8.onnx', dir: 'model', url: modelUrl('joiner.int8.onnx'), size: 6355277, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98' },
  { name: 'tokens.txt', dir: 'model', url: modelUrl('tokens.txt'), size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  {
    name: VAD_FILE,
    dir: 'vad',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    size: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  },
];

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

export function asrPaths(cacheDir: string): { runtimeRoot: string; modelDir: string; vadPath: string } {
  return {
    runtimeRoot: join(cacheDir, RUNTIME_DIR),
    modelDir: join(cacheDir, MODELS_DIR, ASR_MODEL_ID),
    vadPath: join(cacheDir, MODELS_DIR, VAD_FILE),
  };
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
}

export interface AsrInstaller {
  status(): AsrStatus;
  install(options?: AsrInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
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

function fileTarget(cacheDir: string, file: AsrFile): string {
  const paths = asrPaths(cacheDir);
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
  const files = options.files ?? ASR_FILES;
  const reason = unsupportedReason(platform, arch);
  const runtime = reason === undefined && runtimePresent(options.cacheDir, platform, arch);
  const models = files.every((file) => hasFileOfSize(fileTarget(options.cacheDir, file), file.size));
  const paths = asrPaths(options.cacheDir);
  return {
    installed: runtime && models,
    runtime,
    models,
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
  const files = options.files ?? ASR_FILES;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const paths = asrPaths(options.cacheDir);
  const reason = unsupportedReason(platform, arch);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let running: Promise<void> | undefined;

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

  async function download(file: AsrFile, before: number, install: AsrInstallOptions, restarted = false): Promise<void> {
    const target = fileTarget(options.cacheDir, file);
    const part = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    let have = await partSize(part);
    if (have > file.size) {
      await rm(part, { force: true });
      have = 0;
    }
    const emit = (done: number) => install.onProgress?.({ file: file.name, done: before + done, total: totalBytes });
    emit(have);
    if (have === file.size) {
      if ((await sha256Of(part)) === file.sha256) {
        await renameWithRetry(ops, part, target, backoffMs);
        return;
      }
      await rm(part, { force: true });
      return download(file, before, install, restarted);
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
      if (!restarted) return download(file, before, install, true);
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
    await installRuntime();
    let before = 0;
    for (const file of files) {
      if (!hasFileOfSize(fileTarget(options.cacheDir, file), file.size)) await download(file, before, install);
      before += file.size;
    }
  }

  return {
    status: () => getAsrStatus({ cacheDir: options.cacheDir, env: options.env, platform, arch, files }),
    install(install = {}) {
      if (running) return running;
      running = perform(install).finally(() => {
        running = undefined;
      });
      return running;
    },
    async uninstall() {
      await rm(paths.runtimeRoot, { recursive: true, force: true });
      await rm(join(options.cacheDir, MODELS_DIR), { recursive: true, force: true });
    },
  };
}
