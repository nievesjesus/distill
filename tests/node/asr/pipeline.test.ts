import { describe, expect, it } from 'vitest';
import { runPipeline } from '../../../src/node/asr/pipeline';

class FakeVad {
  fed = 0;
  queue: { start: number; samples: Float32Array }[] = [];
  flushed = false;
  private offset = 0;
  acceptWaveform(samples: Float32Array) {
    this.fed += samples.length;
    this.offset += samples.length;
    if (this.offset >= 16000) {
      this.queue.push({ start: 4000, samples: new Float32Array(8000) });
      this.offset -= 16000;
    }
  }
  isEmpty() {
    return this.queue.length === 0;
  }
  front() {
    return this.queue[0];
  }
  pop() {
    this.queue.shift();
  }
  flush() {
    this.flushed = true;
    this.queue.push({ start: 40000, samples: new Float32Array(16000) });
  }
}

async function* chunks(sizes: number[]): AsyncGenerator<Float32Array> {
  for (const n of sizes) yield new Float32Array(n);
}

describe('runPipeline', () => {
  it('feeds the VAD every decoded sample, flushes it and reports the real duration', async () => {
    const vad = new FakeVad();
    const events: any[] = [];
    const sizes = [1000, 4097, 513, 20000, 3, 9999];
    const total = sizes.reduce((a, b) => a + b, 0);
    const result = await runPipeline({
      pcm: chunks(sizes),
      vad,
      recognize: (samples) => ({ text: ` seg${samples.length} ` }),
      emit: (e) => events.push(e),
    });
    expect(vad.flushed).toBe(true);
    expect(vad.fed).toBe(Math.ceil(total / 512) * 512);
    expect(result.duration).toBeCloseTo(total / 16000, 3);
    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0].duration).toBeCloseTo(total / 16000, 3);
    expect(events.at(-1).type).toBe('done');
  });

  it('turns VAD segments into timed, trimmed segments in seconds', async () => {
    const vad = new FakeVad();
    const events: any[] = [];
    await runPipeline({ pcm: chunks([20000]), vad, recognize: () => ({ text: '  hello there ', lang: 'en' }), emit: (e) => events.push(e) });
    const segments = events.filter((e) => e.type === 'segment');
    expect(segments[0]).toEqual({ type: 'segment', start: 0.25, end: 0.75, text: 'hello there', lang: 'en' });
  });

  it('never reports a segment ending after the audio does', async () => {
    const vad = new FakeVad();
    const events: any[] = [];
    const result = await runPipeline({ pcm: chunks([30000]), vad, recognize: () => ({ text: 'tail' }), emit: (e) => events.push(e) });
    const ends = events.filter((e) => e.type === 'segment').map((e) => e.end);
    expect(Math.max(...ends)).toBeLessThanOrEqual(result.duration);
  });

  it('skips segments whose text is empty', async () => {
    const vad = new FakeVad();
    const events: any[] = [];
    await runPipeline({ pcm: chunks([20000]), vad, recognize: () => ({ text: '   ' }), emit: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'segment')).toHaveLength(0);
  });

  it('emits progress as audio is consumed', async () => {
    const vad = new FakeVad();
    const events: any[] = [];
    await runPipeline({ pcm: chunks([16000, 16000, 16000]), vad, recognize: () => ({ text: 'a' }), emit: (e) => events.push(e), progressEverySeconds: 1 });
    const progress = events.filter((e) => e.type === 'progress').map((e) => e.seconds);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.at(-1)).toBeLessThanOrEqual(3);
  });
});
