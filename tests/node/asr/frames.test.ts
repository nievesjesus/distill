import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSlides, dHash, hamming, keyframeArgs, parseShowinfo, sameFrame, slidesFromOcr, thumbArgs } from '../../../src/node/asr/frames';

const flat = (value: number) => Array.from({ length: 72 }, () => value);
const withCell = (base: number, cell: number, value: number) => {
  const out = flat(base);
  out[cell] = value;
  return out;
};

describe('dHash', () => {
  it('compares each pixel with its right neighbour over 8 rows of 9', () => {
    expect(dHash(Uint8Array.from(flat(100)))).toBe(0n);
    const ramp = Uint8Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 10);
    expect(dHash(ramp)).toBe((1n << 64n) - 1n);
  });

  it('counts differing bits', () => {
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0b1011n, 0b0001n)).toBe(2);
    expect(hamming((1n << 64n) - 1n, 0n)).toBe(64);
  });
});

describe('sameFrame', () => {
  it('treats compression noise as the same frame', () => {
    expect(sameFrame(Uint8Array.from(flat(255)), Uint8Array.from(withCell(255, 5, 254)))).toBe(true);
  });

  it('keeps a small on-screen change apart even when the hash barely moves', () => {
    const a = Uint8Array.from(flat(255));
    const b = Uint8Array.from(withCell(255, 20, 218));
    expect(hamming(dHash(a), dHash(b))).toBeLessThanOrEqual(6);
    expect(sameFrame(a, b)).toBe(false);
  });

  it('keeps a single added bullet apart from the previous frame', () => {
    expect(sameFrame(Uint8Array.from(flat(255)), Uint8Array.from(withCell(255, 20, 250)))).toBe(false);
    expect(sameFrame(Uint8Array.from(flat(255)), Uint8Array.from(withCell(255, 20, 253)))).toBe(true);
  });

  it('separates frames whose hashes are far apart', () => {
    const a = Uint8Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 10);
    const b = Uint8Array.from({ length: 72 }, (_, i) => (i % 9) * 10);
    expect(sameFrame(a, b)).toBe(false);
  });
});

describe('parseShowinfo', () => {
  it('reads pts_time of every frame in order', () => {
    const stderr = [
      '[Parsed_showinfo_2 @ 0x1] n:   0 pts:      0 pts_time:0       duration:      1 duration_time:10 fmt:rgb24',
      'noise line',
      '[Parsed_showinfo_2 @ 0x1] n:   1 pts:  12800 pts_time:10.5    duration:      1',
      '[Parsed_showinfo_2 @ 0x1] n:   2 pts:  25600 pts_time:20.04   duration:      1',
    ].join('\n');
    expect(parseShowinfo(stderr)).toEqual([0, 10.5, 20.04]);
  });
});

describe('keyframeArgs', () => {
  it('builds the scene pass: keyframes only, whitelist before -i, absolute input', () => {
    const args = keyframeArgs('/m/a b.mp4', { type: 'scene' }, 'fps_mode', '/tmp/x');
    expect(args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'info',
      '-skip_frame',
      'nokey',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      resolve('/m/a b.mp4'),
      '-an',
      '-vf',
      "select='gt(scene,0.3)',scale=1280:-2,showinfo",
      '-fps_mode',
      'vfr',
      '-frame_pts',
      '1',
      '-frames:v',
      '200',
      join('/tmp/x', 'f-%06d.png'),
    ]);
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
  });

  it('builds the interval pass without skipping frames', () => {
    const args = keyframeArgs('-evil.mp4', { type: 'interval', seconds: 10 }, 'vsync', '/tmp/x');
    expect(args).not.toContain('-skip_frame');
    expect(args[args.indexOf('-i') + 1]).toBe(resolve('-evil.mp4'));
    expect(args).toContain('fps=1/10,scale=1280:-2,showinfo');
    expect(args[args.indexOf('-vsync') + 1]).toBe('vfr');
    expect(args).not.toContain('-fps_mode');
  });

  it('builds a 9x8 gray thumbnail command with the same protocol limit', () => {
    const args = thumbArgs('/tmp/x/f-000001.png');
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file,pipe']);
    expect(args).toContain('scale=9:8:flags=area,format=gray');
    expect(args.slice(-3)).toEqual(['-f', 'rawvideo', 'pipe:1']);
  });
});

describe('slidesFromOcr', () => {
  it('emits only the lines that were not in the previous frame', () => {
    const slides = slidesFromOcr([
      { at: 0, text: 'Acme Corp\nQ3 Revenue 4.2 million' },
      { at: 10, text: 'Acme Corp\nHiring plan 2027 14 engineers' },
      { at: 20, text: 'Acme Corp\nLaunch roadmap March 15' },
    ]);
    expect(slides).toEqual([
      { at: 0, lines: ['Acme Corp', 'Q3 Revenue 4.2 million'] },
      { at: 10, lines: ['Hiring plan 2027 14 engineers'] },
      { at: 20, lines: ['Launch roadmap March 15'] },
    ]);
  });

  it('skips a frame whose text only differs by case or punctuation', () => {
    const slides = slidesFromOcr([
      { at: 0, text: 'Q3 Revenue 4.2 million' },
      { at: 10, text: 'q3 revenue 4.2 million.' },
      { at: 20, text: '  Q3   Revenue 4.2 million ' },
    ]);
    expect(slides).toEqual([{ at: 0, lines: ['Q3 Revenue 4.2 million'] }]);
  });

  it('drops OCR noise lines and frames with no text', () => {
    const slides = slidesFromOcr([
      { at: 0, text: '' },
      { at: 5, text: '| .\n~\nReal title here' },
      { at: 9, text: '--' },
    ]);
    expect(slides).toEqual([{ at: 5, lines: ['Real title here'] }]);
  });

  it('strips Markdown headings, comments and image placeholders from OCR output', () => {
    const slides = slidesFromOcr([{ at: 3, text: '## Quarterly results\n<!-- page 1 -->\n![image](x.png)\nRevenue grew' }]);
    expect(slides).toEqual([{ at: 3, lines: ['Quarterly results', 'Revenue grew'] }]);
  });

  it('shows a slide again when another one came in between', () => {
    const slides = slidesFromOcr([
      { at: 0, text: 'Plan A' },
      { at: 10, text: 'Plan B' },
      { at: 20, text: 'Plan A' },
    ]);
    expect(slides.map((slide) => slide.at)).toEqual([0, 10, 20]);
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

interface FakeFrame {
  file: number;
  time: number;
  thumb: number[];
  text: string;
}

interface Plan {
  scene?: FakeFrame[];
  interval?: FakeFrame[];
  noFpsMode?: boolean;
  failAll?: boolean;
}

function fakeFfmpeg(plan: Plan) {
  const calls: string[][] = [];
  const spawn = ((_cmd: string, args: string[], opts: { shell?: boolean }) => {
    calls.push(args);
    expect(opts.shell).toBe(false);
    const child = new FakeChild();
    setImmediate(() => {
      const finish = (code: number) => {
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit('close', code, null));
      };
      if (plan.failAll) {
        child.stderr.write('Invalid data found when processing input\n');
        return finish(1);
      }
      if (args.includes('rawvideo')) {
        const meta = JSON.parse(readFileSync(args[args.indexOf('-i') + 1], 'utf8')) as FakeFrame;
        child.stdout.write(Buffer.from(meta.thumb));
        return finish(0);
      }
      const scene = args.includes('-skip_frame');
      if (args.includes('-fps_mode') && plan.noFpsMode) {
        child.stderr.write("Unrecognized option 'fps_mode'.\nError splitting the argument list: Option not found\n");
        return finish(1);
      }
      const frames = (scene ? plan.scene : plan.interval) ?? [];
      const dir = dirname(args[args.length - 1]);
      frames.forEach((frame, n) => {
        writeFileSync(join(dir, `f-${String(frame.file).padStart(6, '0')}.png`), JSON.stringify(frame));
        child.stderr.write(`[Parsed_showinfo_2 @ 0x1] n:   ${n} pts:      ${frame.file} pts_time:${frame.time}       duration:      1\n`);
      });
      finish(0);
    });
    return child;
  }) as any;
  return { spawn, calls };
}

function ocrFromFile(order: string[] = []) {
  let active = 0;
  let peak = 0;
  const fn = async (png: string) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    const meta = JSON.parse(readFileSync(png, 'utf8')) as FakeFrame;
    order.push(meta.text);
    active--;
    return meta.text;
  };
  return { fn, peak: () => peak };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frames-test-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const three: FakeFrame[] = [
  { file: 1, time: 4.5, thumb: flat(255), text: 'Q3 Revenue' },
  { file: 2, time: 12, thumb: withCell(255, 3, 200), text: 'Hiring plan' },
  { file: 3, time: 31.25, thumb: withCell(255, 40, 150), text: 'Launch roadmap' },
];

describe('collectSlides', () => {
  it('removes stale distill-frames directories from the temp root and keeps fresh ones', async () => {
    const stale = join(root, 'distill-frames-stale');
    const fresh = join(root, 'distill-frames-fresh');
    const other = join(root, 'something-else');
    for (const dir of [stale, fresh, other]) mkdirSync(dir);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocrFromFile().fn, spawn: fakeFfmpeg({ scene: three }).spawn, tmpRoot: root });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('extracts once when the scene pass finds enough frames, and times slides from pts_time', async () => {
    const ffmpeg = fakeFfmpeg({ scene: three });
    const ocr = ocrFromFile();
    const slides = await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocr.fn, spawn: ffmpeg.spawn, tmpRoot: root });
    expect(slides).toEqual([
      { at: 4.5, lines: ['Q3 Revenue'] },
      { at: 12, lines: ['Hiring plan'] },
      { at: 31.25, lines: ['Launch roadmap'] },
    ]);
    const extractions = ffmpeg.calls.filter((args) => args.includes('-frame_pts'));
    expect(extractions).toHaveLength(1);
    expect(extractions[0]).toContain('-skip_frame');
    expect(ocr.peak()).toBe(1);
  });

  it('falls back to one frame every 10 s when the scene pass finds fewer than 3', async () => {
    const ffmpeg = fakeFfmpeg({ scene: three.slice(0, 2), interval: three });
    const slides = await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocrFromFile().fn, spawn: ffmpeg.spawn, tmpRoot: root });
    const extractions = ffmpeg.calls.filter((args) => args.includes('-frame_pts'));
    expect(extractions).toHaveLength(2);
    expect(extractions[1]).not.toContain('-skip_frame');
    expect(extractions[1]).toContain('fps=1/10,scale=1280:-2,showinfo');
    expect(slides).toHaveLength(3);
  });

  it('widens the interval so a long video still yields at most 200 frames', async () => {
    const ffmpeg = fakeFfmpeg({ scene: [], interval: three });
    await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 4001, ocr: ocrFromFile().fn, spawn: ffmpeg.spawn, tmpRoot: root });
    const interval = ffmpeg.calls.filter((args) => args.includes('-frame_pts')).pop()!;
    expect(interval).toContain('fps=1/21,scale=1280:-2,showinfo');
  });

  it('runs OCR only on frames that differ from the previous kept frame', async () => {
    const same: FakeFrame[] = [
      { file: 1, time: 1, thumb: flat(255), text: 'Title' },
      { file: 2, time: 2, thumb: flat(254), text: 'Title again' },
      { file: 3, time: 3, thumb: flat(255), text: 'Title once more' },
      { file: 4, time: 4, thumb: withCell(255, 10, 100), text: 'Next slide' },
    ];
    const order: string[] = [];
    const slides = await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 10, ocr: ocrFromFile(order).fn, spawn: fakeFfmpeg({ scene: same }).spawn, tmpRoot: root });
    expect(order).toEqual(['Title', 'Next slide']);
    expect(slides).toEqual([
      { at: 1, lines: ['Title'] },
      { at: 4, lines: ['Next slide'] },
    ]);
  });

  it('retries with -vsync when this ffmpeg does not know -fps_mode', async () => {
    const ffmpeg = fakeFfmpeg({ scene: three, noFpsMode: true });
    const slides = await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocrFromFile().fn, spawn: ffmpeg.spawn, tmpRoot: root });
    expect(ffmpeg.calls.some((args) => args.includes('-vsync'))).toBe(true);
    expect(slides).toHaveLength(3);
  });

  it('returns no slides instead of failing when ffmpeg cannot read frames', async () => {
    const slides = await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocrFromFile().fn, spawn: fakeFfmpeg({ failAll: true }).spawn, tmpRoot: root });
    expect(slides).toEqual([]);
  });

  it('returns no slides when OCR throws on a frame', async () => {
    const slides = await collectSlides('/m/v.mp4', {
      ffmpeg: '/bin/ffmpeg',
      duration: 40,
      ocr: async () => {
        throw new Error('ocr broke');
      },
      spawn: fakeFfmpeg({ scene: three }).spawn,
      tmpRoot: root,
    });
    expect(slides).toEqual([]);
  });

  it('removes its temporary frames', async () => {
    await collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocrFromFile().fn, spawn: fakeFfmpeg({ scene: three }).spawn, tmpRoot: root });
    expect(readdirSync(root)).toEqual([]);
  });

  it('kills ffmpeg and raises aborted when the signal fires, cleaning up', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const spawned = vi.fn(() => child);
    const run = collectSlides('/m/v.mp4', { ffmpeg: '/bin/ffmpeg', duration: 40, ocr: ocrFromFile().fn, spawn: spawned as any, tmpRoot: root, signal: controller.signal });
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(child.killed).toBe(true);
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});
