import { describe, expect, it } from 'vitest';
import { buildRecognizerConfig, createLanguageLock, createRecognition, majorityLanguage } from '../../../src/node/asr/recognizer';
import type { WorkerModel } from '../../../src/node/asr/recognizer';

const parakeet: WorkerModel = { kind: 'transducer', files: { encoder: '/m/encoder.int8.onnx', decoder: '/m/decoder.int8.onnx', joiner: '/m/joiner.int8.onnx', tokens: '/m/tokens.txt' } };
const whisper: WorkerModel = { kind: 'whisper', files: { encoder: '/m/small-encoder.int8.onnx', decoder: '/m/small-decoder.int8.onnx', tokens: '/m/small-tokens.txt' } };

describe('majorityLanguage', () => {
  it('picks the most frequent code', () => {
    expect(majorityLanguage(['es', 'en', 'es', 'pt', 'es'])).toBe('es');
  });
  it('breaks ties by first occurrence', () => {
    expect(majorityLanguage(['en', 'es', 'es', 'en'])).toBe('en');
  });
  it('is undefined for no input', () => {
    expect(majorityLanguage([])).toBeUndefined();
  });
});

describe('createLanguageLock', () => {
  it('fixes the majority after five observations and reports it once', () => {
    const lock = createLanguageLock({});
    const fixed = ['es', 'en', 'es', 'es'].map((l) => lock.observe(l));
    expect(fixed).toEqual([undefined, undefined, undefined, undefined]);
    expect(lock.current()).toBeUndefined();
    expect(lock.observe('pt')).toBe('es');
    expect(lock.current()).toBe('es');
    expect(lock.observe('en')).toBeUndefined();
    expect(lock.final()).toBe('es');
  });

  it('ignores missing languages when counting', () => {
    const lock = createLanguageLock({});
    for (const l of ['ja', undefined, 'ja', undefined, 'ja', 'ja']) lock.observe(l);
    expect(lock.current()).toBeUndefined();
    expect(lock.observe('zh')).toBe('ja');
  });

  it('falls back to the majority so far when fewer than five were seen', () => {
    const lock = createLanguageLock({});
    lock.observe('zh');
    lock.observe('zh');
    lock.observe('en');
    expect(lock.current()).toBeUndefined();
    expect(lock.final()).toBe('zh');
  });

  it('never observes when the language is forced', () => {
    const lock = createLanguageLock({ forced: 'de' });
    for (const l of ['es', 'es', 'es', 'es', 'es']) expect(lock.observe(l)).toBeUndefined();
    expect(lock.current()).toBe('de');
    expect(lock.final()).toBe('de');
  });

  it('honours a custom sample size', () => {
    const lock = createLanguageLock({ after: 2 });
    lock.observe('fr');
    expect(lock.observe('fr')).toBe('fr');
  });
});

describe('buildRecognizerConfig', () => {
  it('builds the parakeet transducer config', () => {
    expect(buildRecognizerConfig(parakeet, 4)).toEqual({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: '/m/encoder.int8.onnx', decoder: '/m/decoder.int8.onnx', joiner: '/m/joiner.int8.onnx' },
        tokens: '/m/tokens.txt',
        modelType: 'nemo_transducer',
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
    });
  });

  it('builds the whisper config with auto language', () => {
    expect(buildRecognizerConfig(whisper, 2)).toEqual({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: '/m/small-encoder.int8.onnx', decoder: '/m/small-decoder.int8.onnx', language: '', task: 'transcribe', tailPaddings: -1 },
        tokens: '/m/small-tokens.txt',
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    });
  });

  it('fixes the whisper language and ignores it for parakeet', () => {
    expect(buildRecognizerConfig(whisper, 2, 'ja').modelConfig.whisper.language).toBe('ja');
    expect(buildRecognizerConfig(parakeet, 2, 'ja').modelConfig).not.toHaveProperty('whisper');
  });
});

class FakeRecognizer {
  static instances: FakeRecognizer[] = [];
  static script: { text: string; lang?: string }[] = [];
  configs: any[] = [];
  setCalls: any[] = [];
  index = 0;
  constructor(config: any) {
    this.configs.push(config);
    FakeRecognizer.instances.push(this);
  }
  createStream() {
    return { acceptWaveform: () => undefined };
  }
  decode() {}
  getResult() {
    return FakeRecognizer.script[this.index++] ?? { text: '' };
  }
  setConfig(config: any) {
    this.setCalls.push(config);
  }
}

describe('createRecognition', () => {
  const sherpa = { OfflineRecognizer: FakeRecognizer };
  const samples = new Float32Array(16);

  function run(model: WorkerModel, script: { text: string; lang?: string }[], language?: string) {
    FakeRecognizer.instances = [];
    FakeRecognizer.script = script;
    const languages: string[] = [];
    const session = createRecognition({ sherpa, model, threads: 4, language, onLanguage: (l) => languages.push(l) });
    const results = script.map(() => session.recognize(samples));
    return { session, results, languages, recognizer: FakeRecognizer.instances[0] };
  }

  it('fixes the majority language with setConfig after five non-empty segments and keeps earlier text', () => {
    const script = ['es', 'en', 'es', 'es', 'pt', 'en'].map((lang, i) => ({ text: `t${i}`, lang }));
    const { session, results, languages, recognizer } = run(whisper, script);
    expect(results.map((r) => r.text)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    expect(recognizer.setCalls).toHaveLength(1);
    expect(recognizer.setCalls[0].modelConfig.whisper.language).toBe('es');
    expect(languages).toEqual(['es']);
    expect(session.language()).toBe('es');
  });

  it('does not count empty segments', () => {
    const script = [{ text: '', lang: 'en' }, { text: 'a', lang: 'ja' }, { text: ' ', lang: 'en' }, { text: 'b', lang: 'ja' }, { text: 'c', lang: 'ja' }, { text: 'd', lang: 'ja' }];
    const { recognizer, languages } = run(whisper, script);
    expect(recognizer.setCalls).toHaveLength(0);
    expect(languages).toEqual([]);
    script.push({ text: 'e', lang: 'zh' });
    FakeRecognizer.script = script;
    const again = run(whisper, script);
    expect(again.recognizer.setCalls[0].modelConfig.whisper.language).toBe('ja');
  });

  it('uses the majority so far for the final language when fewer than five segments exist', () => {
    const { session, recognizer } = run(whisper, [{ text: 'a', lang: 'zh' }, { text: 'b', lang: 'zh' }]);
    expect(recognizer.setCalls).toHaveLength(0);
    expect(session.language()).toBe('zh');
  });

  it('builds with the forced language and never calls setConfig', () => {
    const script = Array.from({ length: 7 }, (_, i) => ({ text: `t${i}`, lang: 'es' }));
    const { session, recognizer, languages } = run(whisper, script, 'de');
    expect(recognizer.configs[0].modelConfig.whisper.language).toBe('de');
    expect(recognizer.setCalls).toHaveLength(0);
    expect(languages).toEqual(['de']);
    expect(session.language()).toBe('de');
  });

  it('keeps parakeet untouched and ignores language', () => {
    const script = Array.from({ length: 7 }, (_, i) => ({ text: `t${i}` }));
    const { session, recognizer, languages } = run(parakeet, script, 'de');
    expect(recognizer.configs[0].modelConfig.transducer.joiner).toBe('/m/joiner.int8.onnx');
    expect(recognizer.setCalls).toHaveLength(0);
    expect(languages).toEqual([]);
    expect(session.language()).toBeUndefined();
  });
});
