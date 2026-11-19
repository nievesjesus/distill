import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Slide } from '../../core/transcript';
import type { SpawnFn } from './decode';
import { AsrError } from './errors';

export const MAX_FRAMES = 200;
export const MIN_SCENE_FRAMES = 3;
export const SCENE_THRESHOLD = 0.3;
export const INTERVAL_SECONDS = 10;
export const HASH_DISTANCE = 6;
export const PIXEL_GUARD = 8;

const THUMB_WIDTH = 9;
const THUMB_HEIGHT = 8;
const THUMB_BYTES = THUMB_WIDTH * THUMB_HEIGHT;
const THUMB_CONCURRENCY = 4;
const MIN_LINE_CHARS = 3;
const STDERR_CAP = 1 << 20;
const SYNC_UNSUPPORTED = /fps_mode|vsync|Option not found|Unrecognized option/i;

export type KeyframeMode = { type: 'scene' } | { type: 'interval'; seconds: number };
export type SyncFlag = 'fps_mode' | 'vsync';

export function keyframeArgs(input: string, mode: KeyframeMode, sync: SyncFlag, outDir: string): string[] {
  const filter =
    mode.type === 'scene'
      ? `select='gt(scene,${SCENE_THRESHOLD})',scale=1280:-2,showinfo`
      : `fps=1/${mode.seconds},scale=1280:-2,showinfo`;
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'info',
    ...(mode.type === 'scene' ? ['-skip_frame', 'nokey'] : []),
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    resolve(input),
    '-an',
    '-vf',
    filter,
    `-${sync}`,
    'vfr',
    '-frame_pts',
    '1',
    '-frames:v',
    String(MAX_FRAMES),
    join(outDir, 'f-%06d.png'),
  ];
}

export function thumbArgs(path: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', resolve(path), '-vf', `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'];
}

export function parseShowinfo(stderr: string): number[] {
  const times: number[] = [];
  for (const match of stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/g)) times.push(Number(match[1]));
  return times;
}

export function dHash(gray: Uint8Array): bigint {
  let hash = 0n;
  for (let row = 0; row < THUMB_HEIGHT; row++) {
    for (let col = 0; col < THUMB_WIDTH - 1; col++) {
      hash = (hash << 1n) | (gray[row * THUMB_WIDTH + col] > gray[row * THUMB_WIDTH + col + 1] ? 1n : 0n);
    }
  }
  return hash;
}

export function hamming(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let bits = 0;
  while (diff > 0n) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits;
}

export function sameFrame(a: Uint8Array, b: Uint8Array): boolean {
  if (hamming(dHash(a), dHash(b)) > HASH_DISTANCE) return false;
  for (let i = 0; i < THUMB_BYTES; i++) if (Math.abs(a[i] - b[i]) >= PIXEL_GUARD) return false;
  return true;
}

const normalize = (line: string) => line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function ocrLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const raw of markdown.split('\n')) {
    if (/^\s*<!--.*-->\s*$/.test(raw) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(raw)) continue;
    const line = raw.replace(/^\s*#{1,6}\s+/, '').replace(/\s+/g, ' ').trim();
    if ((line.match(/[\p{L}\p{N}]/gu) ?? []).length >= MIN_LINE_CHARS) lines.push(line);
  }
  return lines;
}

export function slidesFromOcr(frames: readonly { at: number; text: string }[]): Slide[] {
  const slides: Slide[] = [];
  let previous = new Set<string>();
  for (const frame of frames) {
    const lines = ocrLines(frame.text);
    if (lines.length === 0) continue;
    const keys = lines.map(normalize);
    const seen = new Set<string>();
    const fresh: string[] = [];
    lines.forEach((line, index) => {
      const key = keys[index];
      if (previous.has(key) || seen.has(key)) return;
      seen.add(key);
      fresh.push(line);
    });
    previous = new Set(keys);
    if (fresh.length > 0) slides.push({ at: frame.at, lines: fresh });
  }
  return slides;
}

interface Run {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

const cancelled = () => new AsrError('aborted', 'Transcription was cancelled');

function run(spawnFn: SpawnFn, bin: string, args: string[], signal: AbortSignal | undefined): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const child = spawnFn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    const onAbort = () => {
      child.kill('SIGKILL');
    };
    const done = () => signal?.removeEventListener('abort', onAbort);
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      done();
      reject(error);
    });
    child.once('close', (code) => {
      done();
      if (signal?.aborted) reject(cancelled());
      else resolveRun({ code, stdout: Buffer.concat(out), stderr });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface Keyframe {
  path: string;
  at: number;
}

export interface SlideOptions {
  ffmpeg: string;
  duration: number;
  ocr: (pngPath: string) => Promise<string>;
  spawn?: SpawnFn;
  signal?: AbortSignal;
  tmpRoot?: string;
}

async function extract(input: string, mode: KeyframeMode, dir: string, spawnFn: SpawnFn, options: SlideOptions): Promise<Keyframe[]> {
  await mkdir(dir, { recursive: true });
  let result = await run(spawnFn, options.ffmpeg, keyframeArgs(input, mode, 'fps_mode', dir), options.signal);
  if (result.code !== 0 && SYNC_UNSUPPORTED.test(result.stderr)) {
    result = await run(spawnFn, options.ffmpeg, keyframeArgs(input, mode, 'vsync', dir), options.signal);
  }
  if (result.code !== 0) return [];
  const files = (await readdir(dir))
    .map((name) => ({ name, order: /^f-(\d+)\.png$/.exec(name) }))
    .filter((entry): entry is { name: string; order: RegExpExecArray } => entry.order !== null)
    .sort((a, b) => Number(a.order[1]) - Number(b.order[1]));
  const times = parseShowinfo(result.stderr);
  return files.slice(0, Math.min(files.length, times.length)).map((entry, index) => ({ path: join(dir, entry.name), at: times[index] }));
}

async function thumbOf(path: string, spawnFn: SpawnFn, options: SlideOptions): Promise<Uint8Array | null> {
  const result = await run(spawnFn, options.ffmpeg, thumbArgs(path), options.signal);
  return result.code === 0 && result.stdout.length >= THUMB_BYTES ? new Uint8Array(result.stdout.subarray(0, THUMB_BYTES)) : null;
}

async function thumbnails(frames: Keyframe[], spawnFn: SpawnFn, options: SlideOptions): Promise<(Uint8Array | null)[]> {
  const thumbs: (Uint8Array | null)[] = new Array(frames.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(THUMB_CONCURRENCY, frames.length) }, async () => {
    while (next < frames.length) {
      const index = next++;
      thumbs[index] = await thumbOf(frames[index].path, spawnFn, options).catch((error) => {
        if (error instanceof AsrError) throw error;
        return null;
      });
    }
  });
  await Promise.all(workers);
  return thumbs;
}

async function distinct(frames: Keyframe[], spawnFn: SpawnFn, options: SlideOptions): Promise<Keyframe[]> {
  const thumbs = await thumbnails(frames, spawnFn, options);
  const kept: Keyframe[] = [];
  let last: Uint8Array | null = null;
  frames.forEach((frame, index) => {
    const thumb = thumbs[index];
    if (thumb !== null && last !== null && sameFrame(last, thumb)) return;
    kept.push(frame);
    last = thumb;
  });
  return kept;
}

export async function collectSlides(input: string, options: SlideOptions): Promise<Slide[]> {
  const spawnFn: SpawnFn = options.spawn ?? nodeSpawn;
  const work = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'distill-frames-'));
  try {
    let frames = await extract(input, { type: 'scene' }, join(work, 'scene'), spawnFn, options);
    if (frames.length < MIN_SCENE_FRAMES) {
      const seconds = Math.max(INTERVAL_SECONDS, Math.ceil(options.duration / MAX_FRAMES));
      frames = await extract(input, { type: 'interval', seconds }, join(work, 'interval'), spawnFn, options);
    }
    const kept = await distinct(frames.slice(0, MAX_FRAMES), spawnFn, options);
    const read: { at: number; text: string }[] = [];
    for (const frame of kept) {
      if (options.signal?.aborted) throw cancelled();
      try {
        read.push({ at: frame.at, text: await options.ocr(frame.path) });
      } catch (error) {
        if (error instanceof AsrError) throw error;
      }
    }
    if (options.signal?.aborted) throw cancelled();
    return slidesFromOcr(read);
  } catch (error) {
    if (error instanceof AsrError) throw error;
    return [];
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
