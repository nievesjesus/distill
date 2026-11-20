import { describe, expect, it, vi } from 'vitest';
import { FFMPEG_MISSING_MESSAGE } from '../../../src/node/asr/errors';
import { MEDIA_AUTO_SECONDS, createMediaGate } from '../../../src/node/asr/gate';

const gate = (over: Record<string, unknown> = {}) =>
  createMediaGate({
    cacheDir: '/c',
    env: {},
    cached: vi.fn(async () => undefined),
    slides: vi.fn(async () => undefined),
    duration: vi.fn(async () => 120),
    resolveFfmpeg: () => '/bin/ffmpeg',
    ...over,
  } as any);

describe('createMediaGate', () => {
  it('allows a file that is already transcribed whatever its length', async () => {
    const g = gate({ cached: async () => ({ segments: [], duration: 9999 }), duration: vi.fn(async () => 9999) });
    expect(await g('/a/x.mp3')).toBe('convert');
  });

  it('allows short files up to ten minutes', async () => {
    expect(MEDIA_AUTO_SECONDS).toBe(600);
    expect(await gate({ duration: async () => 600 })('/a/x.mp3')).toBe('convert');
  });

  it('defers longer files, and files whose length is unknown', async () => {
    expect(await gate({ duration: async () => 601 })('/a/x.mp3')).toEqual({ defer: expect.stringContaining('distill_file') });
    expect(await gate({ duration: async () => undefined })('/a/x.mp3')).toEqual({ defer: expect.any(String) });
  });

  it('names the CLI command and says the next read is instant', async () => {
    const result = (await gate({ duration: async () => 1800 })('/a/talk one.mp3')) as { defer: string };
    expect(result.defer).toContain("distill-llm convert --stdout '/a/talk one.mp3'");
    expect(result.defer).toContain('600000');
    expect(result.defer).toMatch(/30 min/);
    expect(result.defer).toMatch(/instant/);
  });

  it('does not put a hostile file name inside a double-quoted command', async () => {
    const result = (await gate({ duration: async () => 1800 })('/a/$(touch x) "q" it\'s.mp3')) as { defer: string };
    expect(result.defer).toContain("distill-llm convert --stdout '/a/$(touch x) \"q\" it'\\''s.mp3'");
    expect(result.defer).not.toContain('--stdout "');
  });

  it('replaces a path with control characters by a placeholder', async () => {
    const result = (await gate({ duration: async () => 1800 })('/a/x\ny.mp3')) as { defer: string };
    expect(result.defer).toContain("--stdout '<file>'");
  });

  it('explains a missing ffmpeg instead of calling the length unknown', async () => {
    const g = gate({ resolveFfmpeg: () => null, duration: async () => undefined });
    expect(await g('/a/x.mp4')).toEqual({ defer: FFMPEG_MISSING_MESSAGE });
  });

  it('still converts a WAV without ffmpeg', async () => {
    const g = gate({ resolveFfmpeg: () => null, duration: async () => 30 });
    expect(await g('/a/x.wav')).toBe('convert');
  });

  describe('video slides', () => {
    it('treats a transcribed video as not cached until its slides are cached too', async () => {
      const cached = async () => ({ segments: [], duration: 9999 });
      const long = { cached, duration: async () => 9999 };
      expect(await gate({ ...long, slides: async () => undefined })('/a/x.mp4')).toEqual({ defer: expect.any(String) });
      expect(await gate({ ...long, slides: async () => [] })('/a/x.mp4')).toBe('convert');
    });

    it('does not need slides for audio or without ffmpeg', async () => {
      const cached = async () => ({ segments: [], duration: 9999 });
      const slides = vi.fn(async () => undefined);
      expect(await gate({ cached, slides, duration: async () => 9999 })('/a/x.mp3')).toBe('convert');
      expect(await gate({ cached, slides, resolveFfmpeg: () => null, duration: async () => 9999 })('/a/x.mp4')).toBe('convert');
    });
  });
});
