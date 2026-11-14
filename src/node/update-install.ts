import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { realpath as fsRealpath } from 'node:fs/promises';
import type { UpdateInstallStatus } from '../core/types';
import { isInside } from './inside';
import { findNpm as defaultFindNpm, type NpmCommand, type SpawnFn } from './lingua-install';

export interface GlobalUpdater {
  status(): UpdateInstallStatus;
  install(version: string): Promise<void>;
}

export interface GlobalUpdaterOptions {
  packageRoot: string;
  spawn?: SpawnFn;
  findNpm?: () => Promise<NpmCommand | undefined>;
  realpath?: (p: string) => Promise<string>;
  timeoutMs?: number;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_ERROR = 500;
const MAX_CAPTURE = 64 * 1024;
const NOT_GLOBAL = 'distill-llm is not installed globally with npm. Update it the way you installed it.';

interface NpmResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNpm(spawn: SpawnFn, npm: NpmCommand, args: string[], timeoutMs: number): Promise<NpmResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false' };
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ChildProcess;
    const finish = (result: NpmResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ code: null, stdout, stderr: `${stderr}\nnpm did not finish in time` });
    }, timeoutMs);
    try {
      child = spawn(npm.command, [...npm.prefixArgs, ...args], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: null, stdout, stderr: String(error) });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + String(chunk)).slice(-MAX_CAPTURE);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-MAX_CAPTURE);
    });
    child.once('error', (error) => finish({ code: null, stdout, stderr: `${stderr}\n${error.message}` }));
    child.once('close', (code) => finish({ code, stdout, stderr }));
  });
}

export function createGlobalUpdater(opts: GlobalUpdaterOptions): GlobalUpdater {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const locate = opts.findNpm ?? (() => defaultFindNpm());
  const resolvePath = opts.realpath ?? fsRealpath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current: UpdateInstallStatus = { state: 'idle' };
  let running: Promise<void> | undefined;

  const fail = (version: string | undefined, error: string) => {
    current = version === undefined ? { state: 'failed', error } : { state: 'failed', version, error };
  };

  const run = async (version: string): Promise<void> => {
    const npm = await locate();
    if (!npm) return fail(version, 'npm was not found on PATH');
    const root = await runNpm(spawn, npm, ['root', '-g'], timeoutMs);
    const globalRoot = root.stdout.trim();
    if (root.code !== 0 || !globalRoot) return fail(version, root.stderr.trim().slice(-MAX_ERROR) || 'npm root -g failed');
    let inside: boolean;
    try {
      const [pkg, base] = await Promise.all([resolvePath(opts.packageRoot), resolvePath(globalRoot)]);
      inside = isInside(pkg, base);
    } catch (error) {
      return fail(version, error instanceof Error ? error.message : String(error));
    }
    if (!inside) return fail(version, NOT_GLOBAL);
    const result = await runNpm(spawn, npm, ['install', '-g', `distill-llm@${version}`], timeoutMs);
    if (result.code === 0) current = { state: 'done', version };
    else fail(version, result.stderr.trim().slice(-MAX_ERROR) || `npm exited with code ${result.code}`);
  };

  return {
    status: () => ({ ...current }),
    install(version: string): Promise<void> {
      if (running) return running;
      if (!VERSION.test(version)) {
        fail(undefined, 'Invalid version');
        return Promise.resolve();
      }
      current = { state: 'running', version };
      running = run(version)
        .catch((error: unknown) => fail(version, error instanceof Error ? error.message : String(error)))
        .finally(() => {
          running = undefined;
        });
      return running;
    },
  };
}
