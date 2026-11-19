import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatBytes, LinearResampler, WindowFeeder, ffmpegArgs, pcmStream, readWavInfo, wavDuration } from '../../../src/node/asr/decode';
import { AsrError } from '../../../src/node/asr/errors';
import { makeWav, sine } from './helpers';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asr-decode-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function collect(iter: AsyncIterable<Float32Array>): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  for await (const part of iter) parts.push(part);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function wavFile(name: string, buf: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
}

describe('WAV decoding in JS', () => {
  it('reads 16-bit mono 16 kHz samples exactly', async () => {
    const path = wavFile('a.wav', makeWav({ rate: 16000, channels: 1, bits: 16, count: 1000, frames: sine(440, 16000) }));
    const out = await collect(pcmStream(path, { ffmpeg: null }));
    expect(out.length).toBe(1000);
    expect(out[10]).toBeCloseTo(sine(440, 16000)(10), 3);
  });

  it('decodes 24-bit, 32-bit int and 32-bit float', async () => {
    for (const spec of [
      { bits: 24 as const },
      { bits: 32 as const },
      { bits: 32 as const, float: true },
    ]) {
      const path = wavFile(`b${spec.bits}${spec.float ? 'f' : ''}.wav`, makeWav({ rate: 16000, channels: 1, count: 500, frames: sine(300, 16000), ...spec }));
      const out = await collect(pcmStream(path, { ffmpeg: null }));
      expect(out.length).toBe(500);
      expect(out[7]).toBeCloseTo(sine(300, 16000)(7), 4);
    }
  });

  it('mixes channels down to mono', async () => {
    const path = wavFile('s.wav', makeWav({ rate: 16000, channels: 2, bits: 16, count: 200, frames: (_i, c) => (c === 0 ? 0.5 : -0.1) }));
    const out = await collect(pcmStream(path, { ffmpeg: null }));
    expect(out.length).toBe(200);
    expect(out[3]).toBeCloseTo(0.2, 3);
  });

  it('resamples other rates to 16 kHz with the right length', async () => {
    const path = wavFile('r.wav', makeWav({ rate: 44100, channels: 1, bits: 16, count: 44100, frames: sine(220, 44100) }));
    const out = await collect(pcmStream(path, { ffmpeg: null }));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
    expect(out[100]).toBeCloseTo(sine(220, 44100)(Math.round((100 * 44100) / 16000)), 1);
  });

  it('handles WAVE_FORMAT_EXTENSIBLE, extra chunks and an oversized data length', async () => {
    const path = wavFile('e.wav', makeWav({ rate: 16000, channels: 1, bits: 16, count: 321, frames: sine(100, 16000), extensible: true, extraChunk: 11, dataSizeOverride: 0xffffffff }));
    const info = await readWavInfo(path);
    expect(info?.channels).toBe(1);
    expect(info?.dataBytes).toBe(321 * 2);
    const out = await collect(pcmStream(path, { ffmpeg: null }));
    expect(out.length).toBe(321);
  });

  it('reports the duration from the header', async () => {
    const path = wavFile('d.wav', makeWav({ rate: 8000, channels: 1, bits: 16, count: 24000, frames: () => 0 }));
    const info = await readWavInfo(path);
    expect(wavDuration(info!)).toBeCloseTo(3, 5);
  });

  it('returns undefined for non-WAV files', async () => {
    const path = join(dir, 'x.mp3');
    writeFileSync(path, Buffer.from('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000'));
    expect(await readWavInfo(path)).toBeUndefined();
  });

  it('raises no_audio for a WAV with no samples', async () => {
    const path = wavFile('z.wav', makeWav({ rate: 16000, channels: 1, bits: 16, count: 0, frames: () => 0 }));
    await expect(collect(pcmStream(path, { ffmpeg: null }))).rejects.toMatchObject({ code: 'no_audio' });
  });
});

describe('Resampler', () => {
  it('gives the same output however the input is chunked', () => {
    const input = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 7));
    const whole = new LinearResampler(44100, 16000).push(input);
    const r = new LinearResampler(44100, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 333) parts.push(r.push(input.subarray(i, i + 333)));
    const joined = Float32Array.from(parts.flatMap((p) => Array.from(p)));
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < joined.length; i++) expect(joined[i]).toBeCloseTo(whole[i], 5);
  });
});

describe('FloatBytes and WindowFeeder', () => {
  it('carries partial float bytes across odd chunk boundaries', () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => i / 1000);
    const bytes = Buffer.from(samples.buffer);
    const carry = new FloatBytes();
    const parts: Float32Array[] = [];
    const cuts = [1, 3, 6, 4, 7, 5, 11];
    let at = 0;
    let c = 0;
    while (at < bytes.length) {
      const n = cuts[c++ % cuts.length];
      parts.push(carry.push(bytes.subarray(at, at + n)));
      at += n;
    }
    const joined = Float32Array.from(parts.flatMap((p) => Array.from(p)));
    expect(joined.length).toBe(1000);
    expect(Array.from(joined)).toEqual(Array.from(samples));
    expect(carry.pending).toBe(0);
  });

  it('feeds every decoded sample to the VAD across odd chunk sizes', () => {
    const total = 5 * 512 + 137;
    const input = Float32Array.from({ length: total }, (_, i) => i);
    const feeder = new WindowFeeder(512);
    const windows: Float32Array[] = [];
    const sizes = [100, 777, 3, 511, 513, 1, 900, 1000];
    let at = 0;
    let s = 0;
    while (at < total) {
      const n = sizes[s++ % sizes.length];
      windows.push(...feeder.push(input.subarray(at, at + n)));
      at += n;
    }
    const tail = feeder.flush();
    expect(tail).toBeDefined();
    windows.push(tail!);
    expect(windows.every((w) => w.length === 512)).toBe(true);
    expect(feeder.fed).toBe(total);
    const flat = Float32Array.from(windows.flatMap((w) => Array.from(w)));
    expect(Array.from(flat.subarray(0, total))).toEqual(Array.from(input));
    expect(flat.subarray(total).every((v) => v === 0)).toBe(true);
    expect(windows.length).toBe(Math.ceil(total / 512));
  });

  it('flush returns nothing when the stream ended on a window boundary', () => {
    const feeder = new WindowFeeder(512);
    expect(feeder.push(new Float32Array(1024)).length).toBe(2);
    expect(feeder.flush()).toBeUndefined();
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    this.stdout.end();
    this.emit('close', null, 'SIGKILL');
    return true;
  }
}

describe('ffmpeg path', () => {
  it('builds the exact argument list', () => {
    expect(ffmpegArgs('/a b/c.m4a')).toEqual(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', '/a b/c.m4a', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
  });

  it('spawns without a shell and streams f32 samples across odd chunks', async () => {
    const calls: { cmd: string; args: string[]; opts: any }[] = [];
    const child = new FakeChild();
    const spawn = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return child;
    }) as any;
    const samples = Float32Array.from({ length: 700 }, (_, i) => i / 700);
    const bytes = Buffer.from(samples.buffer);
    const path = join(dir, 'clip.m4a');
    writeFileSync(path, 'x');
    const run = collect(pcmStream(path, { ffmpeg: '/usr/bin/ffmpeg', spawn }));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    child.stdout.write(bytes.subarray(0, 5));
    child.stdout.write(bytes.subarray(5, 1001));
    child.stdout.write(bytes.subarray(1001));
    child.stdout.end();
    child.emit('close', 0, null);
    const out = await run;
    expect(Array.from(out)).toEqual(Array.from(samples));
    expect(calls[0].cmd).toBe('/usr/bin/ffmpeg');
    expect(calls[0].opts.shell).toBe(false);
    expect(calls[0].args).toEqual(ffmpegArgs(path));
  });

  it('raises ffmpeg_missing with install hints when there is no ffmpeg', async () => {
    const path = join(dir, 'clip.mp3');
    writeFileSync(path, 'x');
    const err = await collect(pcmStream(path, { ffmpeg: null })).catch((e) => e);
    expect(err).toBeInstanceOf(AsrError);
    expect(err.code).toBe('ffmpeg_missing');
    expect(err.message).toMatch(/brew install ffmpeg/);
    expect(err.message).toMatch(/apt/);
    expect(err.message).toMatch(/winget/);
  });

  it('raises ffmpeg_missing when the binary cannot be spawned', async () => {
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => {
        child.stdout.end();
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        child.emit('close', -2, null);
      });
      return child;
    }) as any;
    const path = join(dir, 'clip.mp3');
    writeFileSync(path, 'x');
    await expect(collect(pcmStream(path, { ffmpeg: '/nope/ffmpeg', spawn }))).rejects.toMatchObject({ code: 'ffmpeg_missing' });
  });

  it('raises no_audio when ffmpeg reports no audio stream', async () => {
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => {
        child.stderr.write('Output file #0 does not contain any stream\n');
        child.stdout.end();
        child.emit('close', 234, null);
      });
      return child;
    }) as any;
    const path = join(dir, 'silent.mp4');
    writeFileSync(path, 'x');
    await expect(collect(pcmStream(path, { ffmpeg: '/usr/bin/ffmpeg', spawn }))).rejects.toMatchObject({ code: 'no_audio' });
  });

  it('raises no_audio when ffmpeg succeeds but decodes zero samples', async () => {
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => {
        child.stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    }) as any;
    const path = join(dir, 'empty.mp3');
    writeFileSync(path, 'x');
    await expect(collect(pcmStream(path, { ffmpeg: '/usr/bin/ffmpeg', spawn }))).rejects.toMatchObject({ code: 'no_audio' });
  });

  it('raises asr_failed with the ffmpeg message on other failures', async () => {
    const child = new FakeChild();
    const spawn = (() => {
      queueMicrotask(() => {
        child.stderr.write('Invalid data found when processing input\n');
        child.stdout.end();
        child.emit('close', 183, null);
      });
      return child;
    }) as any;
    const path = join(dir, 'bad.mp3');
    writeFileSync(path, 'x');
    const err = await collect(pcmStream(path, { ffmpeg: '/usr/bin/ffmpeg', spawn })).catch((e) => e);
    expect(err.code).toBe('asr_failed');
    expect(err.message).toMatch(/Invalid data found/);
  });

  it('kills ffmpeg and raises aborted when the signal fires', async () => {
    const child = new FakeChild();
    const spawn = (() => child) as any;
    const controller = new AbortController();
    const path = join(dir, 'long.mp3');
    writeFileSync(path, 'x');
    const run = collect(pcmStream(path, { ffmpeg: '/usr/bin/ffmpeg', spawn, signal: controller.signal }));
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(child.killed).toBe(true);
  });
});
