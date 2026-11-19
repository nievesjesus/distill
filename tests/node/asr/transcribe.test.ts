import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASR_FILES, ASR_MODEL_ID, asrPaths, asrPlatformPackage } from '../../../src/node/asr-install';
import { AsrError } from '../../../src/node/asr/errors';
import { transcribe } from '../../../src/node/asr/transcribe';
import { makeWav } from './helpers';

let root: string;
let cacheDir: string;
let wav: string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function installFake(): void {
  const paths = asrPaths(cacheDir);
  for (const name of ['sherpa-onnx-node', asrPlatformPackage(process.platform, process.arch)!]) {
    mkdirSync(join(paths.runtimeRoot, 'node_modules', name), { recursive: true });
    writeFileSync(join(paths.runtimeRoot, 'node_modules', name, 'package.json'), '{}');
  }
  mkdirSync(paths.modelDir, { recursive: true });
  for (const file of ASR_FILES) {
    const target = file.dir === 'vad' ? paths.vadPath : join(paths.modelDir, file.name);
    writeFileSync(target, Buffer.alloc(file.size));
  }
}

function worker(body: string): string {
  const path = join(root, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `let raw='';process.stdin.setEncoding('utf8');let started=false;process.stdin.on('data',d=>{raw+=d;const at=raw.indexOf('\\n');if(started||at<0)return;started=true;(async()=>{const req=JSON.parse(raw.slice(0,at));const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');${body}if(!process.__hang)process.exit(0);})();});`,
  );
  return path;
}

const okWorker = `
out({type:'progress',seconds:0.5});
out({type:'segment',start:0.1234,end:1.5,text:'hello world'});
process.stdout.write('not json noise\\n');
out({type:'segment',start:2,end:3.00049,text:'second'});
out({type:'done',duration:3});
`;

const expectedSegments = [
  { start: 0.123, end: 1.5, text: 'hello world' },
  { start: 2, end: 3, text: 'second' },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asr-transcribe-'));
  cacheDir = join(root, 'cache');
  mkdirSync(cacheDir);
  installFake();
  wav = join(root, 'a.wav');
  writeFileSync(wav, makeWav({ rate: 16000, channels: 1, bits: 16, count: 16000, frames: () => 0 }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const grandchildWorker = (pidFile: string, handleTerm: boolean) => `
const { spawn } = await import('node:child_process');
const { writeFileSync } = await import('node:fs');
const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
${handleTerm ? "process.on('SIGTERM', () => { g.kill('SIGKILL'); process.exit(0); });" : "process.on('SIGTERM', () => {});"}
setInterval(()=>{},1000);process.__hang=1;
`;

describe('transcribe', () => {
  it('collects segments from the worker, rounds times and reports progress', async () => {
    const progress: number[] = [];
    const result = await transcribe(wav, { cacheDir, workerPath: worker(okWorker), env: {}, onProgress: (s: number) => progress.push(s) });
    expect(result).toEqual({ segments: expectedSegments, duration: 3, cached: false });
    expect(progress).toEqual([0.5]);
  });

  it('sends the paths, input, thread count and ffmpeg path on stdin', async () => {
    const ffmpeg = join(root, 'ffmpeg');
    writeFileSync(ffmpeg, '');
    const workerPath = worker(`out({type:'segment',start:0,end:1,text:JSON.stringify(req)});out({type:'done',duration:1});`);
    const result = await transcribe(wav, { cacheDir, workerPath, threads: 2, env: { DISTILL_FFMPEG: ffmpeg } });
    const req = JSON.parse(result.segments[0].text);
    const paths = asrPaths(cacheDir);
    expect(req).toMatchObject({ runtimeRoot: paths.runtimeRoot, modelDir: paths.modelDir, vadPath: paths.vadPath, input: wav, threads: 2, ffmpeg });
  });

  it('caches by file hash, model id and format version, and skips the worker on a hit', async () => {
    await transcribe(wav, { cacheDir, workerPath: worker(okWorker), env: {} });
    const file = join(cacheDir, 'transcripts', `${sha(readFileSync(wav))}-${ASR_MODEL_ID}-v1.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ segments: expectedSegments, duration: 3 });
    expect(readdirSync(join(cacheDir, 'transcripts')).filter((n) => n.includes('.tmp'))).toEqual([]);
    const again = await transcribe(wav, { cacheDir, workerPath: worker('process.exit(9)'), env: {} });
    expect(again.cached).toBe(true);
    expect(again.segments).toEqual(expectedSegments);
  });

  it('ignores a corrupt cache file and transcribes again', async () => {
    mkdirSync(join(cacheDir, 'transcripts'));
    writeFileSync(join(cacheDir, 'transcripts', `${sha(readFileSync(wav))}-${ASR_MODEL_ID}-v1.json`), '{nope');
    const result = await transcribe(wav, { cacheDir, workerPath: worker(okWorker), env: {} });
    expect(result.cached).toBe(false);
    expect(result.segments).toHaveLength(2);
  });

  it('raises asr_unavailable when the stack is not installed', async () => {
    rmSync(join(cacheDir, 'asr'), { recursive: true, force: true });
    const err = await transcribe(wav, { cacheDir, workerPath: worker(okWorker), env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(AsrError);
    expect(err.code).toBe('asr_unavailable');
    expect(err.message).toMatch(/distill-llm asr install/);
  });

  it('maps a worker error event to its code and message', async () => {
    const workerPath = worker(`out({type:'error',code:'ffmpeg_missing',message:'ffmpeg is required'});process.exit(1);`);
    await expect(transcribe(wav, { cacheDir, workerPath, env: {} })).rejects.toMatchObject({ code: 'ffmpeg_missing', message: 'ffmpeg is required' });
  });

  it('maps no_audio from the worker', async () => {
    const workerPath = worker(`out({type:'error',code:'no_audio',message:'no audio'});process.exit(1);`);
    await expect(transcribe(wav, { cacheDir, workerPath, env: {} })).rejects.toMatchObject({ code: 'no_audio' });
  });

  it('summarizes stderr when the worker crashes', async () => {
    const workerPath = worker(`console.error('boom: native crash');process.exit(3);`);
    const err = await transcribe(wav, { cacheDir, workerPath, env: {} }).catch((e) => e);
    expect(err.code).toBe('asr_failed');
    expect(err.message).toMatch(/boom: native crash/);
    expect(err.message).toMatch(/3/);
  });

  it('fails when the worker exits cleanly without a done event', async () => {
    const workerPath = worker(`out({type:'segment',start:0,end:1,text:'x'});`);
    await expect(transcribe(wav, { cacheDir, workerPath, env: {} })).rejects.toMatchObject({ code: 'asr_failed' });
  });

  it('does not cache failures', async () => {
    await transcribe(wav, { cacheDir, workerPath: worker('process.exit(2)'), env: {} }).catch(() => undefined);
    expect(existsSync(join(cacheDir, 'transcripts'))).toBe(false);
  });

  it('kills the worker and raises timeout', async () => {
    const started = Date.now();
    await expect(transcribe(wav, { cacheDir, workerPath: worker('setInterval(()=>{},1000);process.__hang=1;'), env: {}, timeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('kills the worker and raises aborted', async () => {
    const controller = new AbortController();
    const run = transcribe(wav, { cacheDir, workerPath: worker('setInterval(()=>{},1000);process.__hang=1;'), env: {}, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
  });

  it('raises aborted at once for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcribe(wav, { cacheDir, workerPath: worker(okWorker), env: {}, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  describe.skipIf(process.platform === 'win32')('child cleanup', () => {
    it('terminates the worker gracefully on abort so its child process is cleaned up', async () => {
      const pidFile = join(root, 'pid');
      const controller = new AbortController();
      const run = transcribe(wav, { cacheDir, workerPath: worker(grandchildWorker(pidFile, true)), env: {}, signal: controller.signal });
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      await sleep(100);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(pid)).toBe(true);
      controller.abort();
      await expect(run).rejects.toMatchObject({ code: 'aborted' });
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
    });

    it('escalates to SIGKILL when the worker ignores SIGTERM', async () => {
      const pidFile = join(root, 'pid2');
      const started = Date.now();
      const run = transcribe(wav, { cacheDir, workerPath: worker(grandchildWorker(pidFile, false)), env: {}, timeoutMs: 400, killGraceMs: 200 });
      await expect(run).rejects.toMatchObject({ code: 'timeout' });
      expect(Date.now() - started).toBeLessThan(4000);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      process.kill(pid, 'SIGKILL');
    });
  });

  it('kills the worker and rejects with asr_failed when onProgress throws', async () => {
    const pidFile = join(root, 'pid3');
    const body = `${grandchildWorker(pidFile, true)}\nout({type:'progress',seconds:1});`;
    const err = await transcribe(wav, {
      cacheDir,
      workerPath: worker(body),
      env: {},
      onProgress: () => {
        throw new Error('callback exploded');
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AsrError);
    expect(err.code).toBe('asr_failed');
    expect(err.message).toMatch(/callback exploded/);
    if (process.platform !== 'win32') {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
    }
  });
});
