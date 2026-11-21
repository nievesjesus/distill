import { describe, expect, it } from 'vitest';
import { ASR_MODELS, ASR_MODEL_NAMES, DEFAULT_ASR_MODEL, isAsrModelName, isAsrLanguage, modelBytes } from '../../../src/node/asr/models';

describe('asr model registry', () => {
  it('lists the three models with parakeet first', () => {
    expect(ASR_MODEL_NAMES).toEqual(['parakeet', 'whisper-turbo', 'whisper-small']);
    expect(DEFAULT_ASR_MODEL).toBe('parakeet');
    expect(isAsrModelName('whisper-small')).toBe(true);
    expect(isAsrModelName('whisper-large')).toBe(false);
    expect(isAsrModelName(undefined)).toBe(false);
  });

  it('keeps the parakeet cache id and kinds', () => {
    expect(ASR_MODELS.parakeet).toMatchObject({ name: 'parakeet', id: 'parakeet-tdt-0.6b-v3-int8', kind: 'transducer', autoSeconds: 600, timeoutFactor: 2 });
    expect(ASR_MODELS['whisper-small']).toMatchObject({ name: 'whisper-small', kind: 'whisper', autoSeconds: 120, timeoutFactor: 4 });
    expect(ASR_MODELS['whisper-turbo']).toMatchObject({ name: 'whisper-turbo', kind: 'whisper', autoSeconds: 90, timeoutFactor: 4 });
    expect(new Set(Object.values(ASR_MODELS).map((m) => m.id)).size).toBe(3);
  });

  it('labels the engine and languages', () => {
    expect(ASR_MODELS.parakeet.engine).toBe('local ASR (Parakeet TDT 0.6B v3)');
    expect(ASR_MODELS['whisper-turbo'].engine).toBe('local ASR (Whisper large-v3-turbo)');
    expect(ASR_MODELS['whisper-small'].engine).toBe('local ASR (Whisper small)');
    expect(ASR_MODELS.parakeet.languages).toMatch(/25/);
    expect(ASR_MODELS['whisper-small'].languages).toMatch(/99/);
  });

  it('pins whisper-turbo files', () => {
    const files = Object.fromEntries(ASR_MODELS['whisper-turbo'].files.map((f) => [f.name, f]));
    expect(files['turbo-encoder.int8.onnx']).toMatchObject({ size: 674716297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' });
    expect(files['turbo-decoder.int8.onnx']).toMatchObject({ size: 361080764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' });
    expect(files['turbo-tokens.txt']).toMatchObject({ size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' });
    expect(files['turbo-encoder.int8.onnx'].url).toBe('https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-encoder.int8.onnx');
  });

  it('pins whisper-small files', () => {
    const files = Object.fromEntries(ASR_MODELS['whisper-small'].files.map((f) => [f.name, f]));
    expect(files['small-encoder.int8.onnx']).toMatchObject({ size: 112442483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' });
    expect(files['small-decoder.int8.onnx']).toMatchObject({ size: 262226114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' });
    expect(files['small-tokens.txt']).toMatchObject({ size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' });
    expect(files['small-encoder.int8.onnx'].url).toBe('https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-encoder.int8.onnx');
  });

  it('sums download sizes', () => {
    expect(modelBytes(ASR_MODELS['whisper-small'])).toBe(112442483 + 262226114 + 816730);
  });

  it('validates language codes', () => {
    expect(isAsrLanguage('ja')).toBe(true);
    expect(isAsrLanguage('yue')).toBe(true);
    expect(isAsrLanguage('J')).toBe(false);
    expect(isAsrLanguage('EN')).toBe(false);
    expect(isAsrLanguage('english')).toBe(false);
    expect(isAsrLanguage('')).toBe(false);
  });
});
