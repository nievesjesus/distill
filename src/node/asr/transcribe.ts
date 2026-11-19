import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASR_MODEL_ID, asrPaths, getAsrStatus, resolveFfmpeg } from '../asr-install';
import { ffprobeArgs, readWavInfo, wavDuration } from './decode';
import { ASR_UNAVAILABLE_MESSAGE, AsrError } from './errors';
import type { AsrErrorCode } from './errors';

export { AsrError } from './errors';
export type { AsrErrorCode } from './errors';

export type AsrSegment = { start: number; end: number; text: string };

export interface TranscribeOptions {
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  threads?: number;
  onProgress?: (seconds: number) => void;
  workerPath?: string;
  killGraceMs?: number;
}

export interface TranscribeResult {
  segments: AsrSegment[];
  duration: number;
  cached: boolean;
}

const CACHE_VERSION = 'v1';
const UNKNOWN_DURATION_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_CAP = 8192;
const ERROR_CODES: readonly AsrErrorCode[] = ['asr_unavailable', 'ffmpeg_missing', 'no_audio', 'asr_failed', 'aborted', 'timeout'];

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function packageRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function defaultWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, 'asr-worker.js');
  if (existsSync(beside)) return beside;
  const root = packageRoot(here);
  const built = root ? join(root, 'dist', 'asr-worker.js') : beside;
  return existsSync(built) ? built : beside;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function cachePath(cacheDir: string, sha: string): string {
  return join(cacheDir, 'transcripts', `${sha}-${ASR_MODEL_ID}-${CACHE_VERSION}.json`);
}

function validSegments(value: unknown): value is AsrSegment[] {
  return (
    Array.isArray(value) &&
    value.every((s) => s && typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string')
  );
}

async function readCache(path: string): Promise<{ segments: AsrSegment[]; duration: number } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { segments?: unknown; duration?: unknown };
    if (validSegments(parsed.segments) && typeof parsed.duration === 'number') return { segments: parsed.segments, duration: parsed.duration };
  } catch {
    return undefined;
  }
  return undefined;
}

async function writeCache(path: string, value: { segments: AsrSegment[]; duration: number }): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

function probeDuration(ffmpeg: string, input: string, platform: NodeJS.Platform): Promise<number | undefined> {
  const probe = join(dirname(ffmpeg), platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!existsSync(probe)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(probe, ffprobeArgs(input), { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const seconds = Number.parseFloat(String(stdout).trim());
      resolve(error || !Number.isFinite(seconds) || seconds <= 0 ? undefined : seconds);
    });
  });
}

async function knownDuration(input: string, ffmpeg: string | null): Promise<number | undefined> {
  const wav = await readWavInfo(input).catch(() => undefined);
  if (wav) return wavDuration(wav);
  return ffmpeg ? probeDuration(ffmpeg, input, process.platform) : undefined;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 400 ? trimmed.slice(-400) : trimmed;
}

interface WorkerRun {
  segments: AsrSegment[];
  duration: number;
}

function runWorker(
  workerPath: string,
  request: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress: ((seconds: number) => void) | undefined,
  killGraceMs: number,
): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    const segments: AsrSegment[] = [];
    let duration: number | undefined;
    let workerError: AsrError | undefined;
    let forced: AsrError | undefined;
    let stderr = '';
    let buffered = '';
    let escalation: NodeJS.Timeout | undefined;

    const kill = (error: AsrError) => {
      if (forced) return;
      forced = error;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const timer = setTimeout(() => kill(new AsrError('timeout', `Transcription timed out after ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    const onAbort = () => kill(new AsrError('aborted', 'Transcription was cancelled'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const handle = (line: string) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'segment' && typeof event.text === 'string' && typeof event.start === 'number' && typeof event.end === 'number') {
        segments.push({ start: round3(event.start), end: round3(event.end), text: event.text });
      } else if (event.type === 'progress' && typeof event.seconds === 'number') {
        try {
          onProgress?.(event.seconds);
        } catch (error) {
          kill(new AsrError('asr_failed', `Progress callback failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      } else if (event.type === 'done' && typeof event.duration === 'number') {
        duration = round3(event.duration);
      } else if (event.type === 'error') {
        const code: AsrErrorCode = ERROR_CODES.includes(event.code) ? event.code : 'asr_failed';
        workerError = new AsrError(code, typeof event.message === 'string' ? event.message : 'Transcription failed');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let at: number;
      while ((at = buffered.indexOf('\n')) >= 0) {
        handle(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      reject(new AsrError('asr_failed', `Could not start the speech worker: ${error.message}`));
    });
    child.on('close', (code, killSignal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      if (buffered.trim()) handle(buffered);
      if (forced) return reject(forced);
      if (workerError) return reject(workerError);
      if (duration !== undefined && code === 0) return resolve({ segments, duration });
      const detail = tail(stderr);
      const how = killSignal ? `was killed by ${killSignal}` : `exited with code ${code}`;
      reject(new AsrError('asr_failed', `The speech worker ${how}${duration === undefined && code === 0 ? ' without finishing' : ''}${detail ? `: ${detail}` : ''}`));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function transcribe(input: string, options: TranscribeOptions): Promise<TranscribeResult> {
  const env = options.env ?? process.env;
  if (options.signal?.aborted) throw new AsrError('aborted', 'Transcription was cancelled');
  const status = getAsrStatus({ cacheDir: options.cacheDir, env });
  if (!status.installed) throw new AsrError('asr_unavailable', ASR_UNAVAILABLE_MESSAGE);

  const sha = await sha256Of(input);
  const file = cachePath(options.cacheDir, sha);
  const hit = await readCache(file);
  if (hit) return { ...hit, cached: true };

  const ffmpeg = resolveFfmpeg(env);
  const known = await knownDuration(input, ffmpeg);
  const timeoutMs = options.timeoutMs ?? (known === undefined ? UNKNOWN_DURATION_TIMEOUT_MS : Math.ceil(known * 2000) + 120_000);
  const paths = asrPaths(options.cacheDir);
  const threads = options.threads ?? Math.max(1, Math.min(4, cpus().length));

  const result = await runWorker(
    options.workerPath ?? defaultWorkerPath(),
    { runtimeRoot: paths.runtimeRoot, modelDir: paths.modelDir, vadPath: paths.vadPath, input, threads, ffmpeg },
    env,
    timeoutMs,
    options.signal,
    options.onProgress,
    options.killGraceMs ?? 2000,
  );
  await writeCache(file, result);
  return { ...result, cached: false };
}
