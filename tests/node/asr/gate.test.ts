import { describe, expect, it, vi } from 'vitest';
import { MEDIA_AUTO_SECONDS, createMediaGate } from '../../../src/node/asr/gate';

const gate = (over: Record<string, unknown> = {}) =>
  createMediaGate({
    cacheDir: '/c',
    env: {},
    cached: vi.fn(async () => undefined),
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
    expect(result.defer).toContain('distill-llm convert --stdout "/a/talk one.mp3"');
    expect(result.defer).toMatch(/30 min/);
    expect(result.defer).toMatch(/instant/);
  });
});
