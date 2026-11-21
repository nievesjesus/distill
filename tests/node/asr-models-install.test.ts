import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASR_RUNTIME_VERSION, asrFilesFor, asrPaths, createAsrInstaller, getAsrStatus, readDefaultModel, selectAsrModel } from '../../src/node/asr-install';
import type { AsrFile } from '../../src/node/asr-install';
import { AsrError } from '../../src/node/asr/errors';
import { ASR_MODELS } from '../../src/node/asr/models';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const BODIES: Record<string, Buffer> = {
  'encoder.int8.onnx': Buffer.from('e'.repeat(1000)),
  'tokens.txt': Buffer.from('<unk> 0\n'),
  'small-encoder.int8.onnx': Buffer.from('s'.repeat(700)),
  'small-tokens.txt': Buffer.from('<|en|> 0\n'),
  'turbo-encoder.int8.onnx': Buffer.from('t'.repeat(900)),
  'silero_vad.onnx': Buffer.from('v'.repeat(300)),
};

const spec = (name: string, dir: AsrFile['dir']): AsrFile => ({ name, dir, url: `https://example.test/${name}`, size: BODIES[name].length, sha256: sha(BODIES[name]) });

const MODEL_FILES = {
  parakeet: [spec('encoder.int8.onnx', 'model'), spec('tokens.txt', 'model'), spec('silero_vad.onnx', 'vad')],
  'whisper-small': [spec('small-encoder.int8.onnx', 'model'), spec('small-tokens.txt', 'model'), spec('silero_vad.onnx', 'vad')],
  'whisper-turbo': [spec('turbo-encoder.int8.onnx', 'model'), spec('silero_vad.onnx', 'vad')],
};

describe('asr models install', () => {
  let root: string;
  let cacheDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'distill-asr-models-'));
    cacheDir = join(root, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    for (const name of ['sherpa-onnx-node', 'sherpa-onnx-darwin-arm64']) {
      mkdirSync(join(cacheDir, 'asr', 'node_modules', name), { recursive: true });
      writeFileSync(join(cacheDir, 'asr', 'node_modules', name, 'package.json'), JSON.stringify({ version: ASR_RUNTIME_VERSION }));
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  function make() {
    const seen: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url.split('/').pop() as string);
      const body = BODIES[url.split('/').pop() as string];
      return new Response(new Uint8Array(body), { status: 200 });
    }) as typeof globalThis.fetch;
    const installer = createAsrInstaller({ cacheDir, runtimeDir: join(root, 'runtime'), platform: 'darwin', arch: 'arm64', modelFiles: MODEL_FILES, fetch, env: { PATH: '' } });
    const status = () => getAsrStatus({ cacheDir, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, modelFiles: MODEL_FILES });
    return { installer, seen, status };
  }

  it('installs only the requested model plus the shared VAD and makes it the default', async () => {
    const { installer, seen, status } = make();
    await installer.install({ model: 'whisper-small' });
    expect(seen.sort()).toEqual(['silero_vad.onnx', 'small-encoder.int8.onnx', 'small-tokens.txt']);
    expect(readFileSync(join(cacheDir, 'asr-models', 'default'), 'utf8').trim()).toBe('whisper-small');
    expect(readDefaultModel(cacheDir)).toBe('whisper-small');
    expect(existsSync(asrPaths(cacheDir, 'parakeet').modelDir)).toBe(false);
    const current = status();
    expect(current.defaultModel).toBe('whisper-small');
    expect(current.model).toBe('whisper-small');
    expect(current.installed).toBe(true);
    expect(current.installedModels!.map((m) => m.name)).toEqual(['whisper-small']);
  });

  it('defaults to parakeet', async () => {
    const { installer, seen } = make();
    await installer.install();
    expect(seen.sort()).toEqual(['encoder.int8.onnx', 'silero_vad.onnx', 'tokens.txt']);
    expect(readDefaultModel(cacheDir)).toBe('parakeet');
  });

  it('keeps the earlier model and shares the VAD when a second model is installed', async () => {
    const { installer, seen, status } = make();
    await installer.install({ model: 'parakeet' });
    seen.length = 0;
    await installer.install({ model: 'whisper-turbo' });
    expect(seen).toEqual(['turbo-encoder.int8.onnx']);
    const current = status();
    expect(current.defaultModel).toBe('whisper-turbo');
    expect(current.installedModels!.map((m) => m.name)).toEqual(['parakeet', 'whisper-turbo']);
    expect(current.installedModels![1].bytes).toBe(900);
    expect(current.vad).toBe(true);
  });

  it('uninstalls one model and falls back to another installed model', async () => {
    const { installer, status } = make();
    await installer.install({ model: 'parakeet' });
    await installer.install({ model: 'whisper-small' });
    await installer.uninstall('whisper-small');
    expect(existsSync(asrPaths(cacheDir, 'whisper-small').modelDir)).toBe(false);
    expect(readDefaultModel(cacheDir)).toBe('parakeet');
    expect(status().installedModels!.map((m) => m.name)).toEqual(['parakeet']);
    expect(status().runtime).toBe(true);
  });

  it('clears the default when the last model is removed', async () => {
    const { installer, status } = make();
    await installer.install({ model: 'whisper-small' });
    await installer.uninstall('whisper-small');
    expect(readDefaultModel(cacheDir)).toBeUndefined();
    expect(existsSync(join(cacheDir, 'asr-models', 'default'))).toBe(false);
    expect(status().defaultModel).toBeNull();
    expect(status().installed).toBe(false);
  });

  it('keeps the default when a non-default model is removed', async () => {
    const { installer } = make();
    await installer.install({ model: 'parakeet' });
    await installer.install({ model: 'whisper-small' });
    await installer.uninstall('parakeet');
    expect(readDefaultModel(cacheDir)).toBe('whisper-small');
  });

  it('uninstalls everything without a model', async () => {
    const { installer } = make();
    await installer.install({ model: 'parakeet' });
    await installer.install({ model: 'whisper-small' });
    await installer.uninstall();
    expect(existsSync(join(cacheDir, 'asr'))).toBe(false);
    expect(existsSync(join(cacheDir, 'asr-models'))).toBe(false);
  });

  it('reports an unknown or invalid default as absent', () => {
    mkdirSync(join(cacheDir, 'asr-models'), { recursive: true });
    writeFileSync(join(cacheDir, 'asr-models', 'default'), 'nonsense\n');
    expect(readDefaultModel(cacheDir)).toBeUndefined();
  });

  it('builds the file list of a model with the shared VAD', () => {
    const names = asrFilesFor('whisper-small').map((f) => f.name);
    expect(names).toEqual([...ASR_MODELS['whisper-small'].files.map((f) => f.name), 'silero_vad.onnx']);
    expect(asrFilesFor('whisper-small').filter((f) => f.dir === 'vad')).toHaveLength(1);
  });
});

describe('selectAsrModel', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'distill-asr-select-'));
    mkdirSync(join(root, 'asr-models'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('falls back to parakeet', () => {
    expect(selectAsrModel({ cacheDir: root, env: {} })).toBe('parakeet');
  });

  it('prefers the persisted default over parakeet', () => {
    writeFileSync(join(root, 'asr-models', 'default'), 'whisper-small');
    expect(selectAsrModel({ cacheDir: root, env: {} })).toBe('whisper-small');
  });

  it('prefers the CLI request over the persisted default', () => {
    writeFileSync(join(root, 'asr-models', 'default'), 'whisper-small');
    expect(selectAsrModel({ cacheDir: root, env: {}, requested: 'whisper-turbo' })).toBe('whisper-turbo');
  });

  it('prefers the environment over everything', () => {
    writeFileSync(join(root, 'asr-models', 'default'), 'whisper-small');
    expect(selectAsrModel({ cacheDir: root, env: { DISTILL_ASR_MODEL: 'parakeet' }, requested: 'whisper-turbo' })).toBe('parakeet');
  });

  it('rejects an unknown model name', () => {
    expect(() => selectAsrModel({ cacheDir: root, env: { DISTILL_ASR_MODEL: 'big' } })).toThrow(AsrError);
    expect(() => selectAsrModel({ cacheDir: root, env: {}, requested: 'big' as never })).toThrow(/parakeet, whisper-turbo, whisper-small/);
  });
});
