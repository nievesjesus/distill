import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASR_RUNTIME_VERSION, asrFilesFor, asrPaths, asrPlatformPackage } from '../../../src/node/asr-install';
import { AsrError } from '../../../src/node/asr/errors';
import { ASR_MODELS } from '../../../src/node/asr/models';
import type { AsrModelName } from '../../../src/node/asr/models';
import { asrTimeoutMs, cachedTranscript, resolveAsrSelection, transcribe } from '../../../src/node/asr/transcribe';
import { makeWav } from './helpers';

let root: string;
let cacheDir: string;
let wav: string;
let capture: string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function installModel(model: AsrModelName): void {
  const paths = asrPaths(cacheDir, model);
  for (const name of ['sherpa-onnx-node', asrPlatformPackage(process.platform, process.arch)!]) {
    mkdirSync(join(paths.runtimeRoot, 'node_modules', name), { recursive: true });
    writeFileSync(join(paths.runtimeRoot, 'node_modules', name, 'package.json'), JSON.stringify({ version: ASR_RUNTIME_VERSION }));
  }
  mkdirSync(paths.modelDir, { recursive: true });
  for (const file of asrFilesFor(model)) {
    const target = file.dir === 'vad' ? paths.vadPath : join(paths.modelDir, file.name);
    writeFileSync(target, '');
    truncateSync(target, file.size);
  }
}

function worker(body: string): string {
  const path = join(root, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `let raw='';process.stdin.setEncoding('utf8');let started=false;process.stdin.on('data',d=>{raw+=d;const at=raw.indexOf('\\n');if(started||at<0)return;started=true;(async()=>{const req=JSON.parse(raw.slice(0,at));const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');${body}process.exit(0);})();});`,
  );
  return path;
}

const echoWorker = () => `
const { writeFileSync } = await import('node:fs');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(req));
out({type:'segment',start:0,end:1,text:'hola'});
out({type:'language',lang:'es'});
out({type:'done',duration:1,lang:'es'});
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asr-transcribe-models-'));
  cacheDir = join(root, 'cache');
  mkdirSync(cacheDir);
  capture = join(root, 'request.json');
  wav = join(root, 'a.wav');
  writeFileSync(wav, makeWav({ rate: 16000, channels: 1, bits: 16, count: 16000, frames: () => 0 }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('asrTimeoutMs', () => {
  it('scales with the model factor plus 120 s', () => {
    expect(asrTimeoutMs(100, ASR_MODELS.parakeet)).toBe(100 * 2000 + 120_000);
    expect(asrTimeoutMs(100, ASR_MODELS['whisper-small'])).toBe(100 * 4000 + 120_000);
    expect(asrTimeoutMs(100, ASR_MODELS['whisper-turbo'])).toBe(100 * 4000 + 120_000);
  });
  it('uses a fixed ceiling when the duration is unknown', () => {
    expect(asrTimeoutMs(undefined, ASR_MODELS.parakeet)).toBe(30 * 60 * 1000);
  });
});

describe('resolveAsrSelection', () => {
  it('uses the environment model and language for whisper', () => {
    const sel = resolveAsrSelection({ cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small', DISTILL_ASR_LANGUAGE: 'ja' } });
    expect(sel.spec.name).toBe('whisper-small');
    expect(sel.language).toBe('ja');
  });
  it('prefers the environment language over the option', () => {
    expect(resolveAsrSelection({ cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small', DISTILL_ASR_LANGUAGE: 'de' }, language: 'ja' }).language).toBe('de');
    expect(resolveAsrSelection({ cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, language: 'ja' }).language).toBe('ja');
  });
  it('ignores the language for parakeet', () => {
    expect(resolveAsrSelection({ cacheDir, env: { DISTILL_ASR_LANGUAGE: 'ja' }, language: 'zh' }).language).toBeUndefined();
  });
  it('rejects an invalid language', () => {
    expect(() => resolveAsrSelection({ cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small', DISTILL_ASR_LANGUAGE: 'EN' } })).toThrow(/DISTILL_ASR_LANGUAGE/);
    expect(() => resolveAsrSelection({ cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, language: 'english' })).toThrow(AsrError);
  });
});

describe('transcribe with models', () => {
  it('fails with asr_unavailable naming the exact install command when the chosen model is missing', async () => {
    installModel('parakeet');
    const err = await transcribe(wav, { cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, workerPath: worker(echoWorker()) }).catch((e) => e);
    expect(err).toBeInstanceOf(AsrError);
    expect(err.code).toBe('asr_unavailable');
    expect(err.message).toContain('distill-llm asr install --model whisper-small');
  });

  it('sends a transducer model request for parakeet', async () => {
    installModel('parakeet');
    const result = await transcribe(wav, { cacheDir, env: {}, workerPath: worker(echoWorker()), threads: 3 });
    const req = JSON.parse(readFileSync(capture, 'utf8'));
    const dir = asrPaths(cacheDir).modelDir;
    expect(req.model).toEqual({ kind: 'transducer', files: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx'), tokens: join(dir, 'tokens.txt') } });
    expect(req).not.toHaveProperty('language');
    expect(req.threads).toBe(3);
    expect(result.model).toBe('parakeet');
  });

  it('sends a whisper model request with the forced language and reports lang', async () => {
    installModel('whisper-small');
    const result = await transcribe(wav, { cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, language: 'es', workerPath: worker(echoWorker()) });
    const req = JSON.parse(readFileSync(capture, 'utf8'));
    const dir = asrPaths(cacheDir, 'whisper-small').modelDir;
    expect(req.model).toEqual({ kind: 'whisper', files: { encoder: join(dir, 'small-encoder.int8.onnx'), decoder: join(dir, 'small-decoder.int8.onnx'), tokens: join(dir, 'small-tokens.txt') } });
    expect(req.language).toBe('es');
    expect(result).toMatchObject({ model: 'whisper-small', lang: 'es', cached: false });
  });

  it('keys the cache by model id, and by language only when forced', async () => {
    installModel('whisper-small');
    const env = { DISTILL_ASR_MODEL: 'whisper-small' };
    const digest = sha(readFileSync(wav));
    await transcribe(wav, { cacheDir, env, workerPath: worker(echoWorker()) });
    expect(existsSync(join(cacheDir, 'transcripts', `${digest}-${ASR_MODELS['whisper-small'].id}-v1.json`))).toBe(true);
    await transcribe(wav, { cacheDir, env, language: 'ja', workerPath: worker(echoWorker()) });
    expect(existsSync(join(cacheDir, 'transcripts', `${digest}-${ASR_MODELS['whisper-small'].id}-ja-v1.json`))).toBe(true);
  });

  it('does not share the cache between models and returns the stored lang', async () => {
    installModel('parakeet');
    installModel('whisper-small');
    await transcribe(wav, { cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, workerPath: worker(echoWorker()) });
    const other = await transcribe(wav, { cacheDir, env: {}, workerPath: worker(`out({type:'segment',start:0,end:1,text:'x'});out({type:'done',duration:1});`) });
    expect(other).toMatchObject({ cached: false, model: 'parakeet' });
    expect(other.lang).toBeUndefined();
    const hit = await transcribe(wav, { cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, workerPath: worker('process.exit(9);') });
    expect(hit).toMatchObject({ cached: true, lang: 'es', model: 'whisper-small' });
  });

  it('reads cached transcripts per selection', async () => {
    installModel('whisper-small');
    const env = { DISTILL_ASR_MODEL: 'whisper-small' };
    expect(await cachedTranscript(wav, cacheDir, { env })).toBeUndefined();
    await transcribe(wav, { cacheDir, env, workerPath: worker(echoWorker()) });
    expect((await cachedTranscript(wav, cacheDir, { env }))?.lang).toBe('es');
    expect(await cachedTranscript(wav, cacheDir, { env, language: 'ja' })).toBeUndefined();
    expect(await cachedTranscript(wav, cacheDir, { env: {} })).toBeUndefined();
  });

  it('drops a malformed lang from the worker', async () => {
    installModel('whisper-small');
    const result = await transcribe(wav, { cacheDir, env: { DISTILL_ASR_MODEL: 'whisper-small' }, workerPath: worker(`out({type:'segment',start:0,end:1,text:'x'});out({type:'done',duration:1,lang:'--> bad'});`) });
    expect(result.lang).toBeUndefined();
  });
});
