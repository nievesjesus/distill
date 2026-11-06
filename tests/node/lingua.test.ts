import { describe, expect, it } from 'vitest';
import { createLingua } from '../../src/node/lingua';
import { countTokens } from '../../src/core/tokens';

interface FakeCall { text: string; rate: number }

function makeFake() {
  const calls: FakeCall[] = [];
  const factories: { name: string; modelName: string; options: any }[] = [];
  let loads = 0;
  let inits = 0;
  const build = (name: string) => async (modelName: string, options: any) => {
    inits += 1;
    factories.push({ name, modelName, options });
    const onProgress = options.modelSpecificOptions?.progress_callback;
    onProgress?.({ status: 'progress_total', progress: 25 });
    onProgress?.({ status: 'progress_total', progress: 100 });
    await Promise.resolve();
    return {
      promptCompressor: {
        compress: async (text: string, o: { rate: number }) => {
          calls.push({ text, rate: o.rate });
          return text.slice(0, Math.ceil(text.length * o.rate));
        },
      },
    };
  };
  const mod = {
    LLMLingua2: { WithBERTMultilingual: build('bert'), WithXLMRoBERTa: build('xlm') },
    configure: (_dir: string) => undefined,
    createTokenizer: () => ({}),
  };
  const load = async () => {
    loads += 1;
    return mod;
  };
  return { calls, factories, load, counts: () => ({ loads, inits }) };
}

const paragraph = (n: number) => `Paragraph ${n}: ` + 'the quick brown fox jumps over the lazy dog. '.repeat(40);
const longText = Array.from({ length: 12 }, (_, i) => paragraph(i)).join('\n\n');

describe('createLingua', () => {
  it('reports not installed when import fails', async () => {
    const l = createLingua({ cacheDir: '/tmp/x', load: () => Promise.reject(new Error('missing')) });
    await expect(l.compress('x', { rate: 0.6 })).rejects.toThrow('missing');
    expect(l.status()).toMatchObject({ installed: false, state: 'error' });
  });

  it('starts idle with tinybert', () => {
    const f = makeFake();
    expect(createLingua({ cacheDir: '/tmp/x', load: f.load }).status()).toEqual({
      installed: true,
      model: 'tinybert',
      state: 'idle',
      progress: 0,
    });
  });

  it('moves to ready and compresses by chunks', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    const out = await l.compress(longText, { rate: 0.5 });
    expect(l.status().state).toBe('ready');
    expect(f.calls.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThan(longText.length);
    expect(f.calls.every((c) => c.rate === 0.5)).toBe(true);
    expect(f.calls.every((c) => countTokens(c.text) <= 512)).toBe(true);
  });

  it('rejects rate outside 0.3..0.9 before loading', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    await expect(l.compress('x', { rate: 0.1 })).rejects.toBeInstanceOf(RangeError);
    await expect(l.compress('x', { rate: 0.95 })).rejects.toBeInstanceOf(RangeError);
    expect(f.counts().loads).toBe(0);
  });

  it('accepts the rate bounds', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    await expect(l.compress('hello world', { rate: 0.3 })).resolves.toBeTypeOf('string');
    await expect(l.compress('hello world', { rate: 0.9 })).resolves.toBeTypeOf('string');
  });

  it('returns empty string for empty input without loading', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    await expect(l.compress('  \n\n ', { rate: 0.5 })).resolves.toBe('');
    expect(f.counts().loads).toBe(0);
    expect(l.status().state).toBe('idle');
  });

  it('shares one init promise across concurrent calls', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    await Promise.all([l.compress('one', { rate: 0.5 }), l.compress('two', { rate: 0.5 }), l.compress('three', { rate: 0.5 })]);
    expect(f.counts()).toEqual({ loads: 1, inits: 1 });
  });

  it('re-initializes when the model changes', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    await l.compress('one', { rate: 0.5 });
    await l.compress('two', { rate: 0.5, model: 'mobilebert' });
    await l.compress('three', { rate: 0.5, model: 'mobilebert' });
    expect(f.counts().inits).toBe(2);
    expect(l.status().model).toBe('mobilebert');
    expect(f.factories.map((x) => x.modelName)).toEqual([
      'atjsh/llmlingua-2-js-tinybert-meetingbank',
      'atjsh/llmlingua-2-js-mobilebert-meetingbank',
    ]);
  });

  it('uses the xlm-roberta factory with external data format', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    await l.compress('one', { rate: 0.5, model: 'xlm-roberta' });
    const call = f.factories[0];
    expect(call.name).toBe('xlm');
    expect(call.modelName).toBe('atjsh/llmlingua-2-js-xlm-roberta-large-meetingbank');
    expect(call.options.modelSpecificOptions.use_external_data_format).toEqual({ 'model.onnx': 1 });
    expect(call.options.transformerJSConfig).toEqual({ device: 'cpu', dtype: 'fp32' });
  });

  it('reports progress while downloading', async () => {
    const seen: { state: string; progress: number }[] = [];
    let lingua: ReturnType<typeof createLingua>;
    const load = async () => ({
      LLMLingua2: {
        WithBERTMultilingual: async (_n: string, options: any) => {
          const cb = options.modelSpecificOptions.progress_callback;
          cb({ status: 'progress_total', progress: 40 });
          seen.push({ state: lingua.status().state, progress: lingua.status().progress });
          cb({ status: 'progress_total', progress: 80 });
          seen.push({ state: lingua.status().state, progress: lingua.status().progress });
          return { promptCompressor: { compress: async (t: string) => t } };
        },
        WithXLMRoBERTa: async () => {
          throw new Error('unused');
        },
      },
      configure: () => undefined,
      createTokenizer: () => ({}),
    });
    lingua = createLingua({ cacheDir: '/tmp/x', load });
    await lingua.compress('hello', { rate: 0.5 });
    expect(seen).toEqual([
      { state: 'downloading', progress: 0.4 },
      { state: 'downloading', progress: 0.8 },
    ]);
    expect(lingua.status()).toMatchObject({ state: 'ready', progress: 1 });
  });

  it('falls back to per-file progress when no aggregate is reported', async () => {
    let lingua: ReturnType<typeof createLingua>;
    let mid = -1;
    const load = async () => ({
      LLMLingua2: {
        WithBERTMultilingual: async (_n: string, options: any) => {
          options.modelSpecificOptions.progress_callback({ status: 'progress', file: 'model.onnx', progress: 50 });
          mid = lingua.status().progress;
          return { promptCompressor: { compress: async (t: string) => t } };
        },
        WithXLMRoBERTa: async () => {
          throw new Error('unused');
        },
      },
      configure: () => undefined,
      createTokenizer: () => ({}),
    });
    lingua = createLingua({ cacheDir: '/tmp/x', load });
    await lingua.compress('hello', { rate: 0.5 });
    expect(mid).toBe(0.5);
  });

  it('sets error on init failure and retries on the next call', async () => {
    let attempts = 0;
    const load = async () => ({
      LLMLingua2: {
        WithBERTMultilingual: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('boom');
          return { promptCompressor: { compress: async (t: string) => t } };
        },
        WithXLMRoBERTa: async () => {
          throw new Error('unused');
        },
      },
      configure: () => undefined,
      createTokenizer: () => ({}),
    });
    const l = createLingua({ cacheDir: '/tmp/x', load });
    await expect(l.compress('hello', { rate: 0.5 })).rejects.toThrow('boom');
    expect(l.status()).toMatchObject({ installed: true, state: 'error' });
    await expect(l.compress('hello', { rate: 0.5 })).resolves.toBe('hello');
    expect(l.status().state).toBe('ready');
  });

  it('splits an oversized paragraph by sentences and joins chunks with blank lines', async () => {
    const f = makeFake();
    const l = createLingua({ cacheDir: '/tmp/x', load: f.load });
    const big = 'This is a sentence about nothing in particular. '.repeat(200);
    await l.compress(big, { rate: 0.5 });
    expect(f.calls.length).toBeGreaterThan(1);
    expect(f.calls.every((c) => countTokens(c.text) <= 512)).toBe(true);
    const out = await l.compress(longText, { rate: 0.9 });
    expect(out).toContain('\n\n');
  });
});
