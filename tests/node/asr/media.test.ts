import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderSrt } from '../../../src/core/transcript';
import { countTokens } from '../../../src/core/tokens';
import { DistillError } from '../../../src/node/errors';
import { AsrError } from '../../../src/node/asr/errors';
import { withMedia } from '../../../src/node/asr/media';
import type { Parser } from '../../../src/node/parse';

const segments = [
  { start: 0, end: 4, text: 'This is the plan for the quarter and we will go to the office.' },
  { start: 11, end: 14, text: 'Now the second topic with them.' },
];

function innerParser(markdown = 'inner markdown'): Parser & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    toMarkdown: vi.fn(async (path: string, opts?: unknown) => {
      calls.push([path, opts]);
      return { markdown, pages: 3, engine: 'liteparse' as const };
    }),
    toJson: vi.fn(async () => ({ inner: true })),
    renderPage: vi.fn(async () => ({ png: Buffer.alloc(0), width: 1, height: 1 })),
    close: vi.fn(),
  } as any;
}

function deps(overrides: Record<string, unknown> = {}) {
  const transcribe = vi.fn(async () => ({ segments, duration: 14.2, cached: false }));
  const collectSlides = vi.fn(async () => [{ at: 10, lines: ['Hiring plan'] }]);
  return { cacheDir: '/cache', env: {}, transcribe, collectSlides, resolveFfmpeg: () => '/bin/ffmpeg', ...overrides } as any;
}

describe('withMedia slide cache', () => {
  function realVideo() {
    const root = mkdtempSync(join(tmpdir(), 'media-slides-'));
    const video = join(root, 'talk.mp4');
    writeFileSync(video, 'not really a video');
    return { root, video };
  }

  it('extracts frames once and serves the slides from the cache afterwards', async () => {
    const { root, video } = realVideo();
    try {
      const d = deps({ cacheDir: join(root, 'cache') });
      const first = await withMedia(innerParser(), d).toMarkdown(video, { timestamps: 'none' });
      const second = await withMedia(innerParser(), d).toMarkdown(video, { timestamps: 'none' });
      expect(d.collectSlides).toHaveBeenCalledTimes(1);
      expect(second.markdown).toBe(first.markdown);
      expect(second.markdown).toContain('Hiring plan');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the slides cache private', async () => {
    if (process.platform === 'win32') return;
    const { root, video } = realVideo();
    try {
      await withMedia(innerParser(), deps({ cacheDir: join(root, 'cache') })).toMarkdown(video);
      expect(statSync(join(root, 'cache', 'transcripts')).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caches a video with no on-screen text too', async () => {
    const { root, video } = realVideo();
    try {
      const d = deps({ cacheDir: join(root, 'cache'), collectSlides: vi.fn(async () => []) });
      await withMedia(innerParser(), d).toMarkdown(video);
      await withMedia(innerParser(), d).toMarkdown(video);
      expect(d.collectSlides).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('withMedia', () => {
  it('turns audio into a headed transcript with SRT tokens as the raw baseline', async () => {
    const d = deps();
    const parser = withMedia(innerParser(), d);
    const out = await parser.toMarkdown('/a/call.m4a');
    expect(out.markdown.startsWith('<!-- distill: transcript of call.m4a, 00:14, en, local ASR (Parakeet TDT 0.6B v3) -->\n\n[00:00] This is the plan')).toBe(true);
    expect(out.pages).toBe(1);
    expect(out.engine).toBe('builtin');
    expect(out.rawTokens).toBe(countTokens(renderSrt(segments)));
    expect(d.transcribe).toHaveBeenCalledWith('/a/call.m4a', expect.objectContaining({ cacheDir: '/cache' }));
    expect(d.collectSlides).not.toHaveBeenCalled();
  });

  it('adds new on-screen text to video, interleaved by time', async () => {
    const d = deps();
    const inner = innerParser('ignored');
    const out = await withMedia(inner, d).toMarkdown('/a/talk.mp4', { timestamps: 'none' });
    expect(out.markdown).toContain('This is the plan for the quarter and we will go to the office.\n\n> [slide 00:10]\n> Hiring plan\n\nNow the second topic with them.');
    expect(d.collectSlides).toHaveBeenCalledWith('/a/talk.mp4', expect.objectContaining({ ffmpeg: '/bin/ffmpeg', duration: 14.2 }));
  });

  it('runs OCR on frames through the inner parser', async () => {
    const d = deps();
    const inner = innerParser('Slide words');
    await withMedia(inner, d).toMarkdown('/a/talk.mp4');
    const options = d.collectSlides.mock.calls[0][1];
    await expect(options.ocr('/tmp/frame.png')).resolves.toBe('Slide words');
    expect(inner.calls.at(-1)?.[0]).toBe('/tmp/frame.png');
  });

  it('skips frames when asked, and for audio', async () => {
    const d = deps();
    await withMedia(innerParser(), d).toMarkdown('/a/talk.mp4', { frames: 'none' });
    expect(d.collectSlides).not.toHaveBeenCalled();
  });

  it('still transcribes a video when there is no ffmpeg for frames', async () => {
    const d = deps({ resolveFfmpeg: () => null });
    const out = await withMedia(innerParser(), d).toMarkdown('/a/talk.mp4');
    expect(d.collectSlides).not.toHaveBeenCalled();
    expect(out.markdown).toContain('This is the plan');
    expect(out.markdown).not.toContain('[slide');
  });

  it('honours the timestamps option', async () => {
    const none = await withMedia(innerParser(), deps()).toMarkdown('/a/x.mp3', { timestamps: 'none' });
    expect(none.markdown).not.toContain('[00:00]');
    const segment = await withMedia(innerParser(), deps()).toMarkdown('/a/x.mp3', { timestamps: 'segment' });
    expect(segment.markdown).toContain('[00:11] Now the second topic');
  });

  it('omits the language from the header when it cannot tell', async () => {
    const d = deps({ transcribe: vi.fn(async () => ({ segments: [{ start: 0, end: 1, text: 'Parakeet' }], duration: 1, cached: true })) });
    const out = await withMedia(innerParser(), d).toMarkdown('/a/x.mp3');
    expect(out.markdown.split('\n')[0]).toBe('<!-- distill: transcript of x.mp3, 00:01, local ASR (Parakeet TDT 0.6B v3) -->');
  });

  it('says so when nothing was said', async () => {
    const d = deps({ transcribe: vi.fn(async () => ({ segments: [], duration: 3, cached: false })) });
    const out = await withMedia(innerParser(), d).toMarkdown('/a/x.mp3');
    expect(out.markdown).toContain('No speech detected');
    expect(out.rawTokens).toBe(0);
  });

  describe('video without an audio track', () => {
    const silent = (extra: Record<string, unknown> = {}) =>
      deps({
        transcribe: vi.fn(async () => {
          throw new AsrError('no_audio', 'This file has no audio track to transcribe.');
        }),
        duration: vi.fn(async () => 30),
        ...extra,
      });

    it('keeps the slides and says there is no speech', async () => {
      const d = silent();
      const out = await withMedia(innerParser(), d).toMarkdown('/a/screen.mp4');
      expect(out.markdown).toBe('<!-- distill: transcript of screen.mp4, 00:30, local ASR (Parakeet TDT 0.6B v3) -->\n\n_No audio track._\n\n> [slide 00:10]\n> Hiring plan');
      expect(d.collectSlides).toHaveBeenCalledWith('/a/screen.mp4', expect.objectContaining({ duration: 30 }));
      expect(out.rawTokens).toBe(0);
    });

    it('still fails when frames are off or the file is audio', async () => {
      await expect(withMedia(innerParser(), silent()).toMarkdown('/a/screen.mp4', { frames: 'none' })).rejects.toMatchObject({ code: 'no_audio' });
      await expect(withMedia(innerParser(), silent()).toMarkdown('/a/x.mp3')).rejects.toMatchObject({ code: 'no_audio' });
    });

    it('still fails when there is no ffmpeg to read frames', async () => {
      await expect(withMedia(innerParser(), silent({ resolveFfmpeg: () => null })).toMarkdown('/a/screen.mp4')).rejects.toMatchObject({ code: 'no_audio' });
    });

    it('omits the duration when it cannot be probed', async () => {
      const out = await withMedia(innerParser(), silent({ duration: vi.fn(async () => undefined) })).toMarkdown('/a/screen.mp4');
      expect(out.markdown.split('\n')[0]).toBe('<!-- distill: transcript of screen.mp4, local ASR (Parakeet TDT 0.6B v3) -->');
    });
  });

  it('forwards the abort signal', async () => {
    const d = deps();
    const controller = new AbortController();
    await withMedia(innerParser(), d).toMarkdown('/a/x.mp3', { signal: controller.signal });
    expect(d.transcribe.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it.each(['asr_unavailable', 'ffmpeg_missing', 'no_audio', 'asr_failed', 'aborted', 'timeout'] as const)('maps the ASR error %s to a DistillError with the same code', async (code) => {
    const d = deps({
      transcribe: vi.fn(async () => {
        throw new AsrError(code, `msg ${code}`);
      }),
    });
    const error = await withMedia(innerParser(), d).toMarkdown('/a/x.mp3').catch((e) => e);
    expect(error).toBeInstanceOf(DistillError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(`msg ${code}`);
  });

  it('lets other errors through unchanged', async () => {
    const d = deps({
      transcribe: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(withMedia(innerParser(), d).toMarkdown('/a/x.mp3')).rejects.toThrow('boom');
  });

  it('hands every other file to the inner parser with its options', async () => {
    const inner = innerParser();
    const d = deps();
    const out = await withMedia(inner, d).toMarkdown('/a/doc.pdf', { mode: 'full', timestamps: 'none' });
    expect(out).toEqual({ markdown: 'inner markdown', pages: 3, engine: 'liteparse' });
    expect(inner.calls[0]).toEqual(['/a/doc.pdf', { mode: 'full', timestamps: 'none' }]);
    expect(d.transcribe).not.toHaveBeenCalled();
  });

  it('exposes the transcript as JSON for audio and delegates otherwise', async () => {
    const inner = innerParser();
    const parser = withMedia(inner, deps());
    expect(await parser.toJson('/a/doc.pdf')).toEqual({ inner: true });
    const json = (await parser.toJson('/a/x.mp3')) as { format: string; segments: unknown[] };
    expect(json.format).toBe('transcript');
    expect(json.segments).toHaveLength(2);
  });

  it('closes and renders through the inner parser', async () => {
    const inner = innerParser();
    const parser = withMedia(inner, deps());
    parser.close();
    expect(inner.close).toHaveBeenCalled();
    await parser.renderPage('/a/doc.pdf', 1, { dpi: 100 });
    expect(inner.renderPage).toHaveBeenCalled();
  });
});
