import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AsrError, FFMPEG_MISSING_MESSAGE } from './errors';

export const SAMPLE_RATE = 16000;
export const VAD_WINDOW = 512;

const READ_BYTES = 1 << 20;
const STDERR_CAP = 8192;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function ffmpegArgs(input: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', resolve(input), '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
}

export function ffprobeArgs(input: string): string[] {
  return ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', resolve(input)];
}

export interface WavInfo {
  float: boolean;
  bits: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  dataStart: number;
  dataBytes: number;
}

export function wavDuration(info: WavInfo): number {
  return Math.floor(info.dataBytes / info.blockAlign) / info.sampleRate;
}

export async function readWavInfo(path: string): Promise<WavInfo | undefined> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(12);
    const read = await handle.read(head, 0, 12, 0);
    if (read.bytesRead < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    let fmt: { float: boolean; bits: number; channels: number; sampleRate: number; blockAlign: number } | undefined;
    let offset = 12;
    while (offset + 8 <= size) {
      const header = Buffer.alloc(8);
      await handle.read(header, 0, 8, offset);
      const id = header.toString('ascii', 0, 4);
      const length = header.readUInt32LE(4);
      const body = offset + 8;
      if (id === 'fmt ') {
        const buf = Buffer.alloc(Math.min(length, 40));
        await handle.read(buf, 0, buf.length, body);
        if (buf.length < 16) return undefined;
        let tag = buf.readUInt16LE(0);
        if (tag === 0xfffe && buf.length >= 26) tag = buf.readUInt16LE(24);
        const bits = buf.readUInt16LE(14);
        const float = tag === 3;
        const supported = (tag === 1 && (bits === 16 || bits === 24 || bits === 32)) || (float && bits === 32);
        if (!supported) return undefined;
        const channels = buf.readUInt16LE(2);
        const sampleRate = buf.readUInt32LE(4);
        if (channels < 1 || sampleRate < 1) return undefined;
        fmt = { float, bits, channels, sampleRate, blockAlign: channels * (bits / 8) };
      } else if (id === 'data') {
        if (!fmt) return undefined;
        const available = Math.max(0, size - body);
        const dataBytes = Math.min(length, available);
        return { ...fmt, dataStart: body, dataBytes: dataBytes - (dataBytes % fmt.blockAlign) };
      }
      offset = body + length + (length % 2);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export class LinearResampler {
  private readonly ratio: number;
  private pos = 0;
  private prev: Float32Array = new Float32Array(0);

  constructor(from: number, to: number) {
    this.ratio = from / to;
  }

  push(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.prev.length + input.length);
    buf.set(this.prev, 0);
    buf.set(input, this.prev.length);
    const out: number[] = [];
    while (this.pos + 1 < buf.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
      this.pos += this.ratio;
    }
    const drop = Math.min(Math.floor(this.pos), buf.length);
    this.prev = buf.slice(drop);
    this.pos -= drop;
    return Float32Array.from(out);
  }
}

export class FloatBytes {
  private rest: Buffer = Buffer.alloc(0);

  get pending(): number {
    return this.rest.length;
  }

  push(chunk: Buffer): Float32Array {
    const buf = this.rest.length === 0 ? chunk : Buffer.concat([this.rest, chunk]);
    const whole = buf.length - (buf.length % 4);
    this.rest = Buffer.from(buf.subarray(whole));
    const out = new Float32Array(whole / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }
}

export class WindowFeeder {
  private rest: Float32Array = new Float32Array(0);
  fed = 0;

  constructor(private readonly size: number = VAD_WINDOW) {}

  push(samples: Float32Array): Float32Array[] {
    this.fed += samples.length;
    let buf = samples;
    if (this.rest.length > 0) {
      buf = new Float32Array(this.rest.length + samples.length);
      buf.set(this.rest, 0);
      buf.set(samples, this.rest.length);
    }
    const windows: Float32Array[] = [];
    let at = 0;
    for (; at + this.size <= buf.length; at += this.size) windows.push(buf.slice(at, at + this.size));
    this.rest = buf.slice(at);
    return windows;
  }

  flush(): Float32Array | undefined {
    if (this.rest.length === 0) return undefined;
    const padded = new Float32Array(this.size);
    padded.set(this.rest, 0);
    this.rest = new Float32Array(0);
    return padded;
  }
}

function sampleAt(buf: Buffer, at: number, info: WavInfo): number {
  if (info.float) return buf.readFloatLE(at);
  if (info.bits === 16) return buf.readInt16LE(at) / 32768;
  if (info.bits === 24) return buf.readIntLE(at, 3) / 8388608;
  return buf.readInt32LE(at) / 2147483648;
}

async function* wavSamples(path: string, info: WavInfo, signal: AbortSignal | undefined): AsyncGenerator<Float32Array> {
  const handle = await open(path, 'r');
  try {
    const bytesPer = info.bits / 8;
    const block = info.blockAlign * Math.max(1, Math.floor(READ_BYTES / info.blockAlign));
    const resampler = info.sampleRate === SAMPLE_RATE ? undefined : new LinearResampler(info.sampleRate, SAMPLE_RATE);
    let consumed = 0;
    while (consumed < info.dataBytes) {
      if (signal?.aborted) throw new AsrError('aborted', 'Transcription was cancelled');
      const want = Math.min(block, info.dataBytes - consumed);
      const buf = Buffer.alloc(want);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await handle.read(buf, filled, want - filled, info.dataStart + consumed + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const frames = Math.floor(filled / info.blockAlign);
      if (frames === 0) break;
      const mono = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < info.channels; c++) sum += sampleAt(buf, f * info.blockAlign + c * bytesPer, info);
        mono[f] = sum / info.channels;
      }
      consumed += filled;
      const out = resampler ? resampler.push(mono) : mono;
      if (out.length > 0) yield out;
    }
  } finally {
    await handle.close();
  }
}

export interface PcmOptions {
  ffmpeg: string | null;
  spawn?: SpawnFn;
  signal?: AbortSignal;
}

const NO_AUDIO = /does not contain any stream|matches no streams|no audio|Output file is empty/i;

async function* ffmpegSamples(path: string, options: PcmOptions): AsyncGenerator<Float32Array> {
  if (options.ffmpeg === null) throw new AsrError('ffmpeg_missing', FFMPEG_MISSING_MESSAGE);
  const spawnFn: SpawnFn = options.spawn ?? nodeSpawn;
  const child = spawnFn(options.ffmpeg, ffmpegArgs(path), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let spawnError: NodeJS.ErrnoException | undefined;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
  });
  const onAbort = () => {
    child.kill('SIGKILL');
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const bytes = new FloatBytes();
  let total = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      const samples = bytes.push(chunk);
      if (samples.length === 0) continue;
      total += samples.length;
      yield samples;
    }
    const code = await closed;
    if (options.signal?.aborted) throw new AsrError('aborted', 'Transcription was cancelled');
    if (spawnError) {
      if (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES') throw new AsrError('ffmpeg_missing', FFMPEG_MISSING_MESSAGE);
      throw new AsrError('asr_failed', `ffmpeg could not start: ${spawnError.message}`);
    }
    if (code !== 0) {
      const detail = stderr.trim();
      if (NO_AUDIO.test(detail)) throw new AsrError('no_audio', 'This file has no audio track to transcribe.');
      throw new AsrError('asr_failed', `ffmpeg failed to decode the file (exit ${code})${detail ? `: ${detail.slice(0, 400)}` : ''}`);
    }
    if (total === 0) throw new AsrError('no_audio', 'This file has no audio track to transcribe.');
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

export async function* pcmStream(path: string, options: PcmOptions): AsyncGenerator<Float32Array> {
  const info = await readWavInfo(path).catch(() => undefined);
  if (info) {
    if (info.dataBytes === 0) throw new AsrError('no_audio', 'This file has no audio samples to transcribe.');
    yield* wavSamples(path, info, options.signal);
    return;
  }
  yield* ffmpegSamples(path, options);
}
