import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, renameSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASR_FILES, ASR_MODEL_ID, ASR_RUNTIME_VERSION, asrPaths, asrPlatformPackage, createAsrInstaller, getAsrStatus, resolveFfmpeg } from '../../src/node/asr-install';
import type { AsrFile } from '../../src/node/asr-install';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    this.emit('close', null, 'SIGKILL');
    return true;
  }
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

const BODIES: Record<string, Buffer> = {
  'encoder.int8.onnx': Buffer.from('e'.repeat(1000)),
  'tokens.txt': Buffer.from('<unk> 0\nhello 1\n'),
  'silero_vad.onnx': Buffer.from('v'.repeat(300)),
};

function spec(name: string, dir: AsrFile['dir']): AsrFile {
  return { name, dir, url: `https://example.test/${name}`, size: BODIES[name].length, sha256: sha(BODIES[name]) };
}

const FILES: AsrFile[] = [spec('encoder.int8.onnx', 'model'), spec('tokens.txt', 'model'), spec('silero_vad.onnx', 'vad')];

function streamOf(chunks: Buffer[], failAfter?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && index >= failAfter) {
        controller.error(new Error('connection reset'));
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[index]));
      index += 1;
    },
  });
}

function split(data: Buffer, parts = 4): Buffer[] {
  const size = Math.ceil(data.length / parts);
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += size) out.push(data.subarray(at, at + size));
  return out;
}

describe('asr installer', () => {
  let root: string;
  let cacheDir: string;
  let runtimeDir: string;
  const npmCalls: { args: string[]; cwd: string }[] = [];
  const npm = { command: '/usr/bin/node', prefixArgs: ['/opt/npm/bin/npm-cli.js'] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'distill-asr-'));
    cacheDir = join(root, 'cache');
    runtimeDir = join(root, 'runtime');
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'package.json'), '{"name":"asr"}');
    writeFileSync(join(runtimeDir, 'package-lock.json'), '{"lockfileVersion":3}');
    npmCalls.length = 0;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  function plant(dir: string, names: string[]) {
    for (const name of names) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ version: ASR_RUNTIME_VERSION }));
    }
  }

  function fakeSpawn(packages = ['sherpa-onnx-node', 'sherpa-onnx-darwin-arm64']) {
    return ((_command: string, args: string[], options: { cwd: string }) => {
      npmCalls.push({ args, cwd: options.cwd });
      const child = new FakeChild();
      queueMicrotask(() => {
        plant(options.cwd, packages);
        child.emit('close', 0, null);
      });
      return child;
    }) as never;
  }

  interface Seen { url: string; range: string | null }

  function make(handler: (url: string, range: string | null, signal?: AbortSignal | null) => Response | Promise<Response>, extra: Record<string, unknown> = {}) {
    const seen: Seen[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const range = headers.get('range');
      seen.push({ url, range });
      return handler(url, range, init?.signal);
    }) as typeof globalThis.fetch;
    const installer = createAsrInstaller({
      cacheDir,
      runtimeDir,
      platform: 'darwin',
      arch: 'arm64',
      files: FILES,
      resolveNpm: async () => npm,
      spawn: fakeSpawn(),
      fetch,
      env: { PATH: '' },
      ...extra,
    });
    return { installer, seen };
  }

  const serveAll = (url: string) => {
    const name = url.split('/').pop() as string;
    return new Response(streamOf(split(BODIES[name])), { status: 200 });
  };

  it('exposes the pinned model files with sizes and sha256', () => {
    expect(ASR_MODEL_ID).toBe('parakeet-tdt-0.6b-v3-int8');
    const byName = Object.fromEntries(ASR_FILES.map((file) => [file.name, file]));
    expect(byName['encoder.int8.onnx']).toMatchObject({ size: 652282294, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479', dir: 'model' });
    expect(byName['decoder.int8.onnx']).toMatchObject({ size: 11845274, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5' });
    expect(byName['joiner.int8.onnx']).toMatchObject({ size: 6355277, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98' });
    expect(byName['tokens.txt']).toMatchObject({ size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' });
    expect(byName['silero_vad.onnx']).toMatchObject({
      size: 643854,
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
      dir: 'vad',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    });
    expect(byName['encoder.int8.onnx'].url).toBe(
      'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8/encoder.int8.onnx',
    );
  });

  it('computes the asr paths', () => {
    expect(asrPaths('/c')).toEqual({
      runtimeRoot: join('/c', 'asr'),
      modelDir: join('/c', 'asr-models', 'parakeet-tdt-0.6b-v3-int8'),
      vadPath: join('/c', 'asr-models', 'silero_vad.onnx'),
      defaultPath: join('/c', 'asr-models', 'default'),
    });
  });

  it('maps platforms to the sherpa-onnx platform package', () => {
    expect(asrPlatformPackage('darwin', 'arm64')).toBe('sherpa-onnx-darwin-arm64');
    expect(asrPlatformPackage('darwin', 'x64')).toBe('sherpa-onnx-darwin-x64');
    expect(asrPlatformPackage('linux', 'x64')).toBe('sherpa-onnx-linux-x64');
    expect(asrPlatformPackage('linux', 'arm64')).toBe('sherpa-onnx-linux-arm64');
    expect(asrPlatformPackage('win32', 'x64')).toBe('sherpa-onnx-win-x64');
    expect(asrPlatformPackage('win32', 'ia32')).toBe('sherpa-onnx-win-ia32');
    expect(asrPlatformPackage('win32', 'arm64')).toBe('sherpa-onnx-win-arm64');
    expect(asrPlatformPackage('freebsd', 'x64')).toBeUndefined();
    expect(asrPlatformPackage('linux', 'riscv64')).toBeUndefined();
  });

  it('installs the runtime and downloads every file, verified, into place', async () => {
    const { installer, seen } = make(serveAll);
    await installer.install();
    expect(npmCalls).toHaveLength(1);
    expect(npmCalls[0].args).toEqual([...npm.prefixArgs, 'ci', '--omit=dev', '--include=peer', '--ignore-scripts', '--no-audit', '--no-fund']);
    const paths = asrPaths(cacheDir);
    expect(existsSync(join(paths.runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'package.json'))).toBe(true);
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
    expect(readFileSync(join(paths.modelDir, 'tokens.txt'))).toEqual(BODIES['tokens.txt']);
    expect(readFileSync(paths.vadPath)).toEqual(BODIES['silero_vad.onnx']);
    expect(seen.map((entry) => entry.url)).toEqual(FILES.map((file) => file.url));
    expect(seen.every((entry) => entry.range === null)).toBe(true);
    expect(readdirSync(paths.modelDir).sort()).toEqual(['encoder.int8.onnx', 'tokens.txt']);
    expect(readdirSync(join(cacheDir, 'asr-models')).sort()).toEqual(['default', 'parakeet-tdt-0.6b-v3-int8', 'silero_vad.onnx']);
    expect(readdirSync(cacheDir).sort()).toEqual(['asr', 'asr-models']);
    const status = installer.status();
    expect(status).toMatchObject({ installed: true, runtime: true, models: true, installable: true });
    expect(status.diskBytes).toBeGreaterThan(1300);
  });

  it('reports byte progress across all files', async () => {
    const { installer } = make(serveAll);
    const events: { done: number; total: number; file: string }[] = [];
    await installer.install({ onProgress: (p) => events.push(p) });
    const total = FILES.reduce((sum, file) => sum + file.size, 0);
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((event) => event.total === total)).toBe(true);
    expect(events[events.length - 1].done).toBe(total);
    expect(events.map((event) => event.done)).toEqual([...events.map((event) => event.done)].sort((a, b) => a - b));
    expect(new Set(events.map((event) => event.file))).toEqual(new Set(FILES.map((file) => file.name)));
  });

  it('is idempotent: a second install downloads and runs nothing', async () => {
    const { installer, seen } = make(serveAll);
    await installer.install();
    seen.length = 0;
    npmCalls.length = 0;
    await installer.install();
    expect(seen).toEqual([]);
    expect(npmCalls).toEqual([]);
  });

  it('fails on a sha256 mismatch, names the file and keeps nothing', async () => {
    const { installer } = make((url) => {
      const name = url.split('/').pop() as string;
      const body = name === 'tokens.txt' ? Buffer.from('X'.repeat(BODIES[name].length)) : BODIES[name];
      return new Response(streamOf(split(body)), { status: 200 });
    });
    await expect(installer.install()).rejects.toThrow(/tokens\.txt.*sha256|sha256.*tokens\.txt/);
    const paths = asrPaths(cacheDir);
    expect(existsSync(join(paths.modelDir, 'tokens.txt'))).toBe(false);
    expect(readdirSync(paths.modelDir).some((name) => name.startsWith('tokens.txt'))).toBe(false);
    expect(installer.status().models).toBe(false);
  });

  it('fails when the server sends more bytes than the pinned size and keeps nothing', async () => {
    const { installer } = make((url) => {
      const name = url.split('/').pop() as string;
      const body = name === 'encoder.int8.onnx' ? Buffer.concat([BODIES[name], Buffer.from('extra')]) : BODIES[name];
      return new Response(streamOf(split(body)), { status: 200 });
    });
    await expect(installer.install()).rejects.toThrow(/encoder\.int8\.onnx/);
    const paths = asrPaths(cacheDir);
    expect(existsSync(join(paths.modelDir, 'encoder.int8.onnx'))).toBe(false);
    expect(readdirSync(paths.modelDir).filter((name) => name.startsWith('encoder'))).toEqual([]);
  });

  it('fails when the file ends short', async () => {
    const { installer } = make((url) => {
      const name = url.split('/').pop() as string;
      return new Response(streamOf(split(BODIES[name].subarray(0, 10))), { status: 200 });
    });
    await expect(installer.install()).rejects.toThrow(/encoder\.int8\.onnx/);
    expect(existsSync(join(asrPaths(cacheDir).modelDir, 'encoder.int8.onnx'))).toBe(false);
  });

  it('fails on an HTTP error status', async () => {
    const { installer } = make(() => new Response('nope', { status: 503 }));
    await expect(installer.install()).rejects.toThrow(/503/);
  });

  it('an interrupted download leaves no half model, only a resumable .part file', async () => {
    const { installer } = make((url) => {
      const name = url.split('/').pop() as string;
      if (name === 'encoder.int8.onnx') return new Response(streamOf(split(BODIES[name]), 2), { status: 200 });
      return serveAll(url);
    });
    await expect(installer.install()).rejects.toThrow();
    const paths = asrPaths(cacheDir);
    expect(existsSync(join(paths.modelDir, 'encoder.int8.onnx'))).toBe(false);
    expect(readdirSync(paths.modelDir)).toEqual(['encoder.int8.onnx.part']);
    expect(installer.status().models).toBe(false);
  });

  it('resumes a .part file with a Range header and appends on 206', async () => {
    const paths = asrPaths(cacheDir);
    mkdirSync(paths.modelDir, { recursive: true });
    const head = BODIES['encoder.int8.onnx'].subarray(0, 400);
    writeFileSync(join(paths.modelDir, 'encoder.int8.onnx.part'), head);
    const { installer, seen } = make((url, range) => {
      const name = url.split('/').pop() as string;
      if (range) {
        expect(name).toBe('encoder.int8.onnx');
        return new Response(streamOf(split(BODIES[name].subarray(400))), { status: 206 });
      }
      return serveAll(url);
    });
    await installer.install();
    expect(seen[0].range).toBe('bytes=400-');
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
    expect(existsSync(join(paths.modelDir, 'encoder.int8.onnx.part'))).toBe(false);
  });

  it('restarts from zero when the server answers 200 to a Range request', async () => {
    const paths = asrPaths(cacheDir);
    mkdirSync(paths.modelDir, { recursive: true });
    writeFileSync(join(paths.modelDir, 'encoder.int8.onnx.part'), Buffer.from('garbage-prefix'));
    const { installer, seen } = make(serveAll);
    await installer.install();
    expect(seen[0].range).toBe('bytes=14-');
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
  });

  it('discards an oversized .part file and downloads fresh', async () => {
    const paths = asrPaths(cacheDir);
    mkdirSync(paths.modelDir, { recursive: true });
    writeFileSync(join(paths.modelDir, 'encoder.int8.onnx.part'), Buffer.alloc(5000));
    const { installer, seen } = make(serveAll);
    await installer.install();
    expect(seen[0].range).toBeNull();
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
  });

  it('verifies and moves a complete .part file without downloading it again', async () => {
    const paths = asrPaths(cacheDir);
    mkdirSync(paths.modelDir, { recursive: true });
    writeFileSync(join(paths.modelDir, 'encoder.int8.onnx.part'), BODIES['encoder.int8.onnx']);
    const { installer, seen } = make(serveAll);
    await installer.install();
    expect(seen.map((entry) => entry.url)).not.toContain(FILES[0].url);
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
    expect(existsSync(join(paths.modelDir, 'encoder.int8.onnx.part'))).toBe(false);
  });

  it('downloads fresh once when a complete .part file fails the sha256 check', async () => {
    const paths = asrPaths(cacheDir);
    mkdirSync(paths.modelDir, { recursive: true });
    writeFileSync(join(paths.modelDir, 'encoder.int8.onnx.part'), Buffer.from('x'.repeat(BODIES['encoder.int8.onnx'].length)));
    const { installer, seen } = make(serveAll);
    await installer.install();
    const encoder = seen.filter((entry) => entry.url === FILES[0].url);
    expect(encoder).toEqual([{ url: FILES[0].url, range: null }]);
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
  });

  it('restarts once from zero when the server rejects the range with 416', async () => {
    const paths = asrPaths(cacheDir);
    mkdirSync(paths.modelDir, { recursive: true });
    writeFileSync(join(paths.modelDir, 'encoder.int8.onnx.part'), BODIES['encoder.int8.onnx'].subarray(0, 400));
    const { installer, seen } = make((url, range) => {
      if (range) return new Response(null, { status: 416 });
      return serveAll(url);
    });
    await installer.install();
    const encoder = seen.filter((entry) => entry.url === FILES[0].url);
    expect(encoder.map((entry) => entry.range)).toEqual(['bytes=400-', null]);
    expect(readFileSync(join(paths.modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
  });

  it('retries the final rename when the file is briefly locked', async () => {
    let failures = 2;
    const { installer } = make(serveAll, {
      renameBackoffMs: 1,
      fileOps: {
        rename: async (from: string, to: string) => {
          if (from.endsWith('.part') && failures > 0) {
            failures -= 1;
            throw Object.assign(new Error('locked'), { code: 'EBUSY' });
          }
          renameSync(from, to);
        },
      },
    });
    await installer.install();
    expect(failures).toBe(0);
    expect(readFileSync(join(asrPaths(cacheDir).modelDir, 'encoder.int8.onnx'))).toEqual(BODIES['encoder.int8.onnx']);
  });

  it('aborts a download when the signal fires', async () => {
    const controller = new AbortController();
    const { installer } = make((_url, _range, signal) => {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        controller.abort();
      });
    });
    await expect(installer.install({ signal: controller.signal })).rejects.toThrow();
    expect(installer.status().models).toBe(false);
  });

  it('fails the runtime step when sherpa-onnx-node is missing after npm', async () => {
    const { installer } = make(serveAll, { spawn: fakeSpawn(['something-else']) });
    await expect(installer.install()).rejects.toThrow(/speech recognition/i);
    expect(existsSync(asrPaths(cacheDir).runtimeRoot)).toBe(false);
  });

  it('requires the platform package as well', async () => {
    const { installer } = make(serveAll, { spawn: fakeSpawn(['sherpa-onnx-node']) });
    await expect(installer.install()).rejects.toThrow(/missing after install/);
  });

  it('refuses unsupported platforms without touching the network or npm', async () => {
    const { installer, seen } = make(serveAll, { platform: 'freebsd', arch: 'x64' });
    await expect(installer.install()).rejects.toThrow(/no prebuilt/i);
    expect(seen).toEqual([]);
    expect(npmCalls).toEqual([]);
    const status = installer.status();
    expect(status.installable).toBe(false);
    expect(status.unsupportedReason).toMatch(/freebsd-x64/);
  });

  it('uninstall removes both directories', async () => {
    const { installer } = make(serveAll);
    await installer.install();
    await installer.uninstall();
    expect(readdirSync(cacheDir)).toEqual([]);
    expect(installer.status()).toMatchObject({ installed: false, runtime: false, models: false, diskBytes: 0 });
  });

  it('uninstall on a clean cache is a no-op', async () => {
    const { installer } = make(serveAll);
    await installer.uninstall();
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  describe('status', () => {
    it('is not installed on an empty cache', () => {
      const status = getAsrStatus({ cacheDir, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, files: FILES });
      expect(status).toEqual({ installed: false, runtime: false, models: false, vad: false, model: 'parakeet', defaultModel: null, installedModels: [], ffmpeg: null, installable: true, diskBytes: 0 });
    });

    it('reports runtime without models', () => {
      plant(asrPaths(cacheDir).runtimeRoot, ['sherpa-onnx-node', 'sherpa-onnx-darwin-arm64']);
      const status = getAsrStatus({ cacheDir, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, files: FILES });
      expect(status).toMatchObject({ installed: false, runtime: true, models: false });
    });

    it('does not count a model file with the wrong size', () => {
      const paths = asrPaths(cacheDir);
      mkdirSync(paths.modelDir, { recursive: true });
      writeFileSync(join(paths.modelDir, 'encoder.int8.onnx'), 'short');
      writeFileSync(join(paths.modelDir, 'tokens.txt'), BODIES['tokens.txt']);
      writeFileSync(paths.vadPath, BODIES['silero_vad.onnx']);
      expect(getAsrStatus({ cacheDir, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, files: FILES }).models).toBe(false);
    });

    it('treats a runtime with a different sherpa-onnx-node version as not installed', () => {
      const root = asrPaths(cacheDir).runtimeRoot;
      plant(root, ['sherpa-onnx-node', 'sherpa-onnx-darwin-arm64']);
      writeFileSync(join(root, 'node_modules', 'sherpa-onnx-node', 'package.json'), JSON.stringify({ version: '1.0.0' }));
      const status = getAsrStatus({ cacheDir, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, files: FILES });
      expect(status.runtime).toBe(false);
      expect(status.installed).toBe(false);
    });

    it('pins the same sherpa-onnx-node version as asr-runtime/package.json', () => {
      const pinned = JSON.parse(readFileSync(join(__dirname, '..', '..', 'asr-runtime', 'package.json'), 'utf8')).dependencies['sherpa-onnx-node'];
      expect(ASR_RUNTIME_VERSION).toBe(pinned);
    });

    it('lists the unsupported reason for platforms without a prebuilt', () => {
      const status = getAsrStatus({ cacheDir, platform: 'linux', arch: 'riscv64', env: { PATH: '' } });
      expect(status.installable).toBe(false);
      expect(status.unsupportedReason).toContain('linux-riscv64');
    });
  });

  describe('resolveFfmpeg', () => {
    it('prefers DISTILL_FFMPEG when it is an absolute existing path', () => {
      const own = join(root, 'my-ffmpeg');
      writeFileSync(own, '#!/bin/sh\n');
      expect(resolveFfmpeg({ DISTILL_FFMPEG: own, PATH: '' })).toBe(own);
    });

    it('ignores a relative or missing DISTILL_FFMPEG and falls back to PATH', () => {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const onPath = join(bin, 'ffmpeg');
      writeFileSync(onPath, '#!/bin/sh\n');
      chmodSync(onPath, 0o755);
      expect(resolveFfmpeg({ DISTILL_FFMPEG: 'ffmpeg', PATH: bin })).toBe(onPath);
      expect(resolveFfmpeg({ DISTILL_FFMPEG: join(root, 'nope'), PATH: bin })).toBe(onPath);
    });

    it('rejects a DISTILL_FFMPEG that is a directory', () => {
      const dir = join(root, 'a-dir');
      mkdirSync(dir);
      expect(resolveFfmpeg({ DISTILL_FFMPEG: dir, PATH: '' })).toBeNull();
    });

    it('looks only for ffmpeg.exe on Windows', () => {
      const bin = join(root, 'winbin');
      mkdirSync(bin);
      const cmd = join(bin, 'ffmpeg.cmd');
      writeFileSync(cmd, '');
      chmodSync(cmd, 0o755);
      expect(resolveFfmpeg({ PATH: bin }, 'win32')).toBeNull();
      const exe = join(bin, 'ffmpeg.exe');
      writeFileSync(exe, '');
      chmodSync(exe, 0o755);
      expect(resolveFfmpeg({ PATH: bin }, 'win32')).toBe(exe);
    });

    it('returns null when nothing is found', () => {
      expect(resolveFfmpeg({ PATH: join(root, 'empty') })).toBeNull();
    });
  });
});
