import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { LinguaInstallError, LinguaInstallErrorCode } from '../core/types';

export const REQUIRED_PACKAGES: readonly string[] = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'];
export const NPM_ARGS: readonly string[] = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];

const INSTALL_DIR = 'lingua';
const TEMP_PREFIX = 'lingua.installing-';
const RUNTIME_FILES = ['package.json', 'package-lock.json'];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
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
  installable(): boolean;
  status(): InstallerStatus;
  install(): Promise<void>;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface InstallerOptions {
  cacheDir: string;
  runtimeDir: string;
  spawn?: SpawnFn;
  resolveNpm?: () => Promise<NpmCommand | undefined>;
  timeoutMs?: number;
}

export class LinguaInstallFailure extends Error {
  constructor(readonly code: LinguaInstallErrorCode, message: string) {
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
    const collect = (chunk: Buffer | string) => {
      captured = (captured + String(chunk)).slice(-MAX_CAPTURE);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const finish = (error?: LinguaInstallFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new LinguaInstallFailure('timeout', 'npm did not finish in time'));
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => finish(new LinguaInstallFailure('npm_failed', summarize(error.message, hidden))));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new LinguaInstallFailure('npm_failed', summarize(captured, hidden) || `npm exited with code ${code}`));
    });
  });
}

async function hasPackages(dir: string): Promise<boolean> {
  const checks = REQUIRED_PACKAGES.map((name) => access(join(dir, 'node_modules', ...name.split('/'), 'package.json'), constants.R_OK).then(() => true, () => false));
  return (await Promise.all(checks)).every(Boolean);
}

async function removeStaleTemporaries(cacheDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }
  await Promise.all(entries.filter((name) => name.startsWith(TEMP_PREFIX)).map((name) => rm(join(cacheDir, name), { recursive: true, force: true })));
}

export function createLinguaInstaller(opts: InstallerOptions): LinguaInstaller {
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
  const resolveNpm = opts.resolveNpm ?? (() => findNpm());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const finalDir = join(opts.cacheDir, INSTALL_DIR);
  const hidden = [opts.cacheDir, opts.runtimeDir, homedir(), tmpdir(), process.cwd()];
  let npm: NpmCommand | undefined;
  let canInstall = false;
  let state: InstallerStatus = { state: 'idle' };
  let running: Promise<void> | undefined;

  async function perform(): Promise<void> {
    npm ??= await resolveNpm();
    canInstall = npm !== undefined;
    if (!npm) throw new LinguaInstallFailure('npm_missing', 'npm is not available to install LLMLingua-2');
    const tempDir = join(opts.cacheDir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(opts.cacheDir, { recursive: true });
      await removeStaleTemporaries(opts.cacheDir);
      await mkdir(tempDir, { recursive: true });
      for (const file of RUNTIME_FILES) await copyFile(join(opts.runtimeDir, file), join(tempDir, file));
      await runNpm(spawn, npm, tempDir, timeoutMs, [...hidden, tempDir]);
      if (!(await hasPackages(tempDir))) {
        throw new LinguaInstallFailure('verify_failed', 'LLMLingua-2 packages are missing after install');
      }
      await rm(finalDir, { recursive: true, force: true });
      await rename(tempDir, finalDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      if (error instanceof LinguaInstallFailure) throw error;
      throw new LinguaInstallFailure('filesystem', 'Could not write the LLMLingua-2 install directory');
    }
  }

  return {
    async probe() {
      npm ??= await resolveNpm();
      canInstall = npm !== undefined;
      return canInstall;
    },
    installable: () => canInstall,
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
