import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { LinguaInstallError, LinguaInstallErrorCode } from '../core/types';

export const REQUIRED_PACKAGES: readonly string[] = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'];
export const NPM_ARGS: readonly string[] = ['ci', '--omit=dev', '--include=peer', '--ignore-scripts', '--no-audit', '--no-fund'];

export const INTEL_MAC_REASON = 'LLMLingua-2 is not available on Intel Macs: its ONNX runtime only supports Apple Silicon.';

const INSTALL_DIR = 'lingua';
const TEMP_PREFIX = 'lingua.installing-';
const OLD_PREFIX = 'lingua.old-';
const RUNTIME_FILES = ['package.json', 'package-lock.json'];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 5000;
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 50;
const STAMPED_LEFTOVER = /^lingua\.(?:installing|old)-(\d{13})-[0-9a-f]+$/;
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);
const MAX_CAPTURE = 16 * 1024;
const MAX_MESSAGE = 300;
const MAX_LINES = 4;
const DROPPED_ENV = ['npm_config_global', 'npm_config_location'];

export interface NpmCommand {
  command: string;
  prefixArgs: string[];
}

export interface InstallerStatus {
  state: 'idle' | 'installing' | 'failed';
  error?: LinguaInstallError;
}

export interface LinguaInstaller {
  probe(): Promise<boolean>;
  sweep(): Promise<void>;
  installable(): boolean;
  unsupportedReason?(): string | undefined;
  status(): InstallerStatus;
  install(): Promise<void>;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface FileOps {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface InstallerOptions {
  cacheDir: string;
  runtimeDir: string;
  fileOps?: Partial<FileOps>;
  renameBackoffMs?: number;
  spawn?: SpawnFn;
  resolveNpm?: () => Promise<NpmCommand | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  arch?: string;
}

export class LinguaInstallFailure extends Error {
  constructor(
    readonly code: LinguaInstallErrorCode,
    message: string,
    readonly keepTemporary = false,
  ) {
    super(message);
    this.name = 'LinguaInstallFailure';
  }
}

export interface FindNpmProbe {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  electron?: boolean;
  isFile?: (path: string) => Promise<boolean>;
  runs?: (command: string, args: string[]) => Promise<boolean>;
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function defaultRuns(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = nodeSpawn(command, [...args, '--version'], { stdio: 'ignore', shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

export async function findNpm(probe: FindNpmProbe = {}): Promise<NpmCommand | undefined> {
  const env = probe.env ?? process.env;
  const platform = probe.platform ?? process.platform;
  const execPath = probe.execPath ?? process.execPath;
  const isElectron = probe.electron ?? process.versions.electron !== undefined;
  const isFile = probe.isFile ?? defaultIsFile;
  const runs = probe.runs ?? defaultRuns;
  if (isElectron) return undefined;

  const path = platform === 'win32' ? win32 : posix;
  const scripts: string[] = [];
  const announced = env.npm_execpath;
  if (announced) {
    const name = path.basename(announced).toLowerCase();
    if (name === 'npm-cli.js') scripts.push(announced);
    else if (name === 'npx-cli.js') scripts.push(path.join(path.dirname(announced), 'npm-cli.js'));
  }
  const nodeDir = path.dirname(execPath);
  scripts.push(
    platform === 'win32'
      ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );

  for (const script of scripts) {
    if (await isFile(script)) {
      const candidate = { command: execPath, prefixArgs: [script] };
      if (await runs(candidate.command, candidate.prefixArgs)) return candidate;
    }
  }
  if (platform !== 'win32' && (await runs('npm', []))) return { command: 'npm', prefixArgs: [] };
  return undefined;
}

function sanitize(text: string, hidden: string[]): string {
  let clean = text;
  const paths = [...new Set(hidden.filter((value) => value.length > 1))].sort((a, b) => b.length - a.length);
  for (const value of paths) clean = clean.split(value).join('…');
  return clean;
}

function summarize(captured: string, hidden: string[]): string {
  const lines = sanitize(captured, hidden)
    .split(/\r?\n/)
    .map((line) => line.replace(/^npm (?:error|ERR!)\s*/i, '').trim())
    .filter(Boolean);
  const text = lines.slice(-MAX_LINES).join(' ');
  return text.length > MAX_MESSAGE ? text.slice(text.length - MAX_MESSAGE) : text;
}

function runNpm(
  spawn: SpawnFn,
  npm: NpmCommand,
  cwd: string,
  timeoutMs: number,
  killGraceMs: number,
  hidden: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false' };
    for (const key of DROPPED_ENV) delete env[key];
    let child: ChildProcess;
    try {
      child = spawn(npm.command, [...npm.prefixArgs, ...NPM_ARGS], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new LinguaInstallFailure('npm_failed', summarize(String(error), hidden)));
      return;
    }
    let captured = '';
    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer | string) => {
      captured = (captured + String(chunk)).slice(-MAX_CAPTURE);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const finish = (error?: LinguaInstallFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (error) reject(error);
      else resolve();
    };
    const timeoutFailure = () => new LinguaInstallFailure('timeout', 'npm did not finish in time');
    const timer = setTimeout(() => {
      timedOut = true;
      graceTimer = setTimeout(() => finish(new LinguaInstallFailure('timeout', 'npm did not finish in time', true)), killGraceMs);
      try {
        child.kill('SIGKILL');
      } catch {
        finish(timeoutFailure());
      }
    }, timeoutMs);
    child.once('error', (error) => finish(timedOut ? timeoutFailure() : new LinguaInstallFailure('npm_failed', summarize(error.message, hidden))));
    child.once('close', (code) => {
      if (timedOut) finish(timeoutFailure());
      else if (code === 0) finish();
      else finish(new LinguaInstallFailure('npm_failed', summarize(captured, hidden) || `npm exited with code ${code}`));
    });
  });
}

async function hasPackages(dir: string): Promise<boolean> {
  const checks = REQUIRED_PACKAGES.map((name) => access(join(dir, 'node_modules', ...name.split('/'), 'package.json'), constants.R_OK).then(() => true, () => false));
  return (await Promise.all(checks)).every(Boolean);
}

function stamped(prefix: string): string {
  return `${prefix}${Date.now()}-${randomBytes(6).toString('hex')}`;
}

async function createdAt(path: string, name: string): Promise<number> {
  const match = STAMPED_LEFTOVER.exec(name);
  return match ? Number(match[1]) : (await stat(path)).mtimeMs;
}

async function removeStaleTemporaries(cacheDir: string, olderThanMs: number, ops: FileOps): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - olderThanMs;
  const leftovers = entries.filter((name) => name.startsWith(TEMP_PREFIX) || name.startsWith(OLD_PREFIX));
  await Promise.all(
    leftovers.map(async (name) => {
      const path = join(cacheDir, name);
      try {
        if ((await createdAt(path, name)) >= cutoff) return;
        await ops.rm(path, { recursive: true, force: true });
      } catch {
        return;
      }
    }),
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function renameWithRetry(ops: FileOps, from: string, to: string, backoffMs: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ops.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
    }
  }
}

export function createLinguaInstaller(opts: InstallerOptions): LinguaInstaller {
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
  const resolveNpm = opts.resolveNpm ?? (() => findNpm());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const staleAfterMs = 2 * timeoutMs + killGraceMs;
  const ops: FileOps = { rename, rm, ...opts.fileOps };
  const backoffMs = opts.renameBackoffMs ?? RENAME_BACKOFF_MS;
  const finalDir = join(opts.cacheDir, INSTALL_DIR);
  const hidden = [opts.cacheDir, opts.runtimeDir, homedir(), tmpdir(), process.cwd()];
  const unsupported = (opts.platform ?? process.platform) === 'darwin' && (opts.arch ?? process.arch) === 'x64' ? INTEL_MAC_REASON : undefined;
  let npm: NpmCommand | undefined;
  let canInstall = false;
  let state: InstallerStatus = { state: 'idle' };
  let running: Promise<void> | undefined;

  async function swapIn(tempDir: string): Promise<void> {
    const asideDir = join(opts.cacheDir, stamped(OLD_PREFIX));
    let movedAside = false;
    try {
      await renameWithRetry(ops, finalDir, asideDir, backoffMs);
      movedAside = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      await renameWithRetry(ops, tempDir, finalDir, backoffMs);
    } catch (error) {
      if (movedAside) await renameWithRetry(ops, asideDir, finalDir, backoffMs).catch(() => undefined);
      throw error;
    }
    if (movedAside) await ops.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async function perform(): Promise<void> {
    if (unsupported) throw new LinguaInstallFailure('unsupported_platform', unsupported);
    npm ??= await resolveNpm();
    canInstall = npm !== undefined;
    if (!npm) throw new LinguaInstallFailure('npm_missing', 'npm is not available to install LLMLingua-2');
    const tempDir = join(opts.cacheDir, stamped(TEMP_PREFIX));
    try {
      await mkdir(opts.cacheDir, { recursive: true });
      await removeStaleTemporaries(opts.cacheDir, staleAfterMs, ops);
      await mkdir(tempDir, { recursive: true });
      for (const file of RUNTIME_FILES) await copyFile(join(opts.runtimeDir, file), join(tempDir, file));
      await runNpm(spawn, npm, tempDir, timeoutMs, killGraceMs, [...hidden, tempDir]);
      if (!(await hasPackages(tempDir))) {
        throw new LinguaInstallFailure('verify_failed', 'LLMLingua-2 packages are missing after install');
      }
      await swapIn(tempDir);
    } catch (error) {
      const keepTemporary = error instanceof LinguaInstallFailure && error.keepTemporary;
      if (!keepTemporary) await ops.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof LinguaInstallFailure) throw error;
      throw new LinguaInstallFailure('filesystem', 'Could not write the LLMLingua-2 install directory');
    }
  }

  return {
    async probe() {
      if (unsupported) return false;
      npm ??= await resolveNpm();
      canInstall = npm !== undefined;
      return canInstall;
    },
    sweep: () => removeStaleTemporaries(opts.cacheDir, staleAfterMs, ops),
    installable: () => canInstall && !unsupported,
    unsupportedReason: () => unsupported,
    status: () => ({ ...state }),
    install() {
      if (running) return running;
      state = { state: 'installing' };
      running = perform().then(
        () => {
          state = { state: 'idle' };
          running = undefined;
        },
        (error: unknown) => {
          const failure = error instanceof LinguaInstallFailure ? error : new LinguaInstallFailure('filesystem', 'Install failed');
          state = { state: 'failed', error: { code: failure.code, message: failure.message } };
          running = undefined;
          throw failure;
        },
      );
      return running;
    },
  };
}
