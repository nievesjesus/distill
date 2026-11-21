import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { asrPaths, getAsrStatus, resolveFfmpeg, selectAsrModel } from '../asr-install';
import { builtWorkerPath } from '../worker-path';
import { readJsonFile, sha256Of, writePrivateJson } from './cache';
import { ffmpegInfoArgs, ffprobeArgs, parseFfmpegDuration, readWavInfo, wavDuration } from './decode';
import { AsrError, asrUnavailableMessage } from './errors';
import { ASR_MODELS, isAsrLanguage, modelBytes, modelFileOf } from './models';
import type { AsrModelName, AsrModelSpec } from './models';
import type { WorkerModel } from './recognizer';
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
  model?: AsrModelName;
  language?: string;
}

export interface TranscribeResult {
  segments: AsrSegment[];
  duration: number;
  cached: boolean;
  model: AsrModelName;
  lang?: string;
}

export interface AsrSelection {
  spec: AsrModelSpec;
  language?: string;
}

export function resolveAsrSelection(options: { cacheDir: string; env?: NodeJS.ProcessEnv; model?: AsrModelName; language?: string }): AsrSelection {
  const env = options.env ?? process.env;
  const spec = ASR_MODELS[selectAsrModel({ cacheDir: options.cacheDir, env, requested: options.model })];
  if (spec.kind !== 'whisper') return { spec };
  const fromEnv = env.DISTILL_ASR_LANGUAGE?.trim();
  const raw = fromEnv ? fromEnv : options.language;
  if (raw === undefined || raw === '') return { spec };
  if (!isAsrLanguage(raw)) {
    throw new AsrError('asr_failed', `${fromEnv ? 'DISTILL_ASR_LANGUAGE' : '--language'} must be a 2 or 3 letter lowercase language code such as es, en or ja.`);
  }
  return { spec, language: raw };
}

export function asrTimeoutMs(duration: number | undefined, spec: AsrModelSpec): number {
  return duration === undefined ? UNKNOWN_DURATION_TIMEOUT_MS : Math.ceil(duration * 1000 * spec.timeoutFactor) + 120_000;
}

const CACHE_VERSION = 'v1';
const UNKNOWN_DURATION_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_CAP = 8192;
const ERROR_CODES: readonly AsrErrorCode[] = ['asr_unavailable', 'ffmpeg_missing', 'no_audio', 'asr_failed', 'aborted', 'timeout'];

const MAX_ASR_CONCURRENCY = 16;

let activeWorkers = 0;
const waiting: (() => void)[] = [];

function concurrencyLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.DISTILL_ASR_CONCURRENCY?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : 1;
  return value >= 1 ? Math.min(value, MAX_ASR_CONCURRENCY) : 1;
}

async function acquireWorkerSlot(env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<() => void> {
  const release = () => {
    activeWorkers -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  for (;;) {
    if (signal?.aborted) throw new AsrError('aborted', 'Transcription was cancelled');
    if (activeWorkers < concurrencyLimit(env)) {
      activeWorkers += 1;
      return release;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const at = waiting.indexOf(wake);
        if (at >= 0) waiting.splice(at, 1);
        reject(new AsrError('aborted', 'Transcription was cancelled'));
      };
      waiting.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function cachePath(cacheDir: string, sha: string, selection: AsrSelection): string {
  const language = selection.language ? `-${selection.language}` : '';
  return join(cacheDir, 'transcripts', `${sha}-${selection.spec.id}${language}-${CACHE_VERSION}.json`);
}

function validSegments(value: unknown): value is AsrSegment[] {
  return (
    Array.isArray(value) &&
    value.every((s) => s && typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string')
  );
}

interface StoredTranscript {
  segments: AsrSegment[];
  duration: number;
  lang?: string;
}

async function readCache(path: string): Promise<StoredTranscript | undefined> {
  const parsed = (await readJsonFile(path)) as { segments?: unknown; duration?: unknown; lang?: unknown } | undefined;
  if (parsed && validSegments(parsed.segments) && typeof parsed.duration === 'number') {
    return { segments: parsed.segments, duration: parsed.duration, ...(isAsrLanguage(parsed.lang) ? { lang: parsed.lang } : {}) };
  }
  return undefined;
}

function probeDuration(ffmpeg: string, input: string, platform: NodeJS.Platform): Promise<number | undefined> {
  const probe = join(dirname(ffmpeg), platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!existsSync(probe)) return ffmpegDuration(ffmpeg, input);
  return new Promise((resolve) => {
    execFile(probe, ffprobeArgs(input), { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const seconds = Number.parseFloat(String(stdout).trim());
      resolve(error || !Number.isFinite(seconds) || seconds <= 0 ? undefined : seconds);
    });
  });
}

function ffmpegDuration(ffmpeg: string, input: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ffmpegInfoArgs(input), { timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20 }, (_error, _stdout, stderr) => {
      resolve(parseFfmpegDuration(String(stderr)));
    });
  });
}

export async function knownDuration(input: string, ffmpeg: string | null): Promise<number | undefined> {
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
  lang?: string;
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
    let lang: string | undefined;
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
      } else if (event.type === 'language' && isAsrLanguage(event.lang)) {
        lang = event.lang;
      } else if (event.type === 'done' && typeof event.duration === 'number') {
        duration = round3(event.duration);
        if (isAsrLanguage(event.lang)) lang = event.lang;
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
      if (duration !== undefined && code === 0) return resolve({ segments, duration, ...(lang ? { lang } : {}) });
      const detail = tail(stderr);
      const how = killSignal ? `was killed by ${killSignal}` : `exited with code ${code}`;
      reject(new AsrError('asr_failed', `The speech worker ${how}${duration === undefined && code === 0 ? ' without finishing' : ''}${detail ? `: ${detail}` : ''}`));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.once('close', () => child.stdin.destroy());
  });
}

export async function cachedTranscript(
  input: string,
  cacheDir: string,
  selection: { env?: NodeJS.ProcessEnv; model?: AsrModelName; language?: string } = {},
): Promise<StoredTranscript | undefined> {
  const resolved = resolveAsrSelection({ cacheDir, ...selection });
  return readCache(cachePath(cacheDir, await sha256Of(input), resolved));
}

function workerModel(cacheDir: string, spec: AsrModelSpec): WorkerModel {
  const dir = asrPaths(cacheDir, spec.name).modelDir;
  const at = (role: 'encoder' | 'decoder' | 'joiner' | 'tokens') => join(dir, modelFileOf(spec, role)!.name);
  return {
    kind: spec.kind,
    files: { encoder: at('encoder'), decoder: at('decoder'), ...(spec.kind === 'transducer' ? { joiner: at('joiner') } : {}), tokens: at('tokens') },
  };
}

export async function transcribe(input: string, options: TranscribeOptions): Promise<TranscribeResult> {
  const env = options.env ?? process.env;
  if (options.signal?.aborted) throw new AsrError('aborted', 'Transcription was cancelled');
  const selection = resolveAsrSelection({ cacheDir: options.cacheDir, env, model: options.model, language: options.language });
  const { spec } = selection;
  const status = getAsrStatus({ cacheDir: options.cacheDir, env, model: spec.name });
  if (!status.installed) throw new AsrError('asr_unavailable', asrUnavailableMessage(spec.name, modelBytes(spec)));

  const sha = await sha256Of(input);
  const file = cachePath(options.cacheDir, sha, selection);
  const hit = await readCache(file);
  if (hit) return { ...hit, cached: true, model: spec.name };

  const release = await acquireWorkerSlot(env, options.signal);
  try {
    const again = await readCache(file);
    if (again) return { ...again, cached: true, model: spec.name };
    const ffmpeg = resolveFfmpeg(env);
    const known = await knownDuration(input, ffmpeg);
    const timeoutMs = options.timeoutMs ?? asrTimeoutMs(known, spec);
    const paths = asrPaths(options.cacheDir, spec.name);
    const threads = options.threads ?? Math.max(1, Math.min(4, cpus().length));

    const result = await runWorker(
      options.workerPath ?? builtWorkerPath('asr-worker.js'),
      {
        runtimeRoot: paths.runtimeRoot,
        model: workerModel(options.cacheDir, spec),
        vadPath: paths.vadPath,
        input,
        threads,
        ffmpeg,
        ...(selection.language ? { language: selection.language } : {}),
      },
      env,
      timeoutMs,
      options.signal,
      options.onProgress,
      options.killGraceMs ?? 2000,
    );
    await writePrivateJson(file, result);
    return { ...result, cached: false, model: spec.name };
  } finally {
    release();
  }
}
