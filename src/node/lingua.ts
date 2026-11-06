import { join } from 'node:path';
import { countTokens } from '../core/tokens';
import type { LinguaModel, LinguaStatus } from '../core/types';

export interface Lingua {
  status(): LinguaStatus;
  compress(text: string, opts: { rate: number; model?: LinguaModel }): Promise<string>;
}

export interface LinguaOptions {
  cacheDir: string;
  load?: () => Promise<unknown>;
}

interface Compressor {
  compress(text: string, opts: { rate: number }): Promise<string>;
}

type Factory = (modelName: string, options: Record<string, unknown>) => Promise<{ promptCompressor: Compressor }>;

interface LinguaModule {
  LLMLingua2: { WithBERTMultilingual: Factory; WithXLMRoBERTa: Factory };
  configure(modelsDir: string): void;
  createTokenizer(): unknown;
}

interface ProgressEvent {
  status?: string;
  progress?: number;
}

const MODEL_IDS: Record<LinguaModel, string> = {
  tinybert: 'atjsh/llmlingua-2-js-tinybert-meetingbank',
  mobilebert: 'atjsh/llmlingua-2-js-mobilebert-meetingbank',
  'xlm-roberta': 'atjsh/llmlingua-2-js-xlm-roberta-large-meetingbank',
};

const MIN_RATE = 0.3;
const MAX_RATE = 0.9;
const CHUNK_TOKENS = 512;

async function defaultLoad(): Promise<LinguaModule> {
  const [lingua, transformers, tiktoken, ranks] = await Promise.all([
    import('@atjsh/llmlingua-2'),
    import('@huggingface/transformers'),
    import('js-tiktoken/lite'),
    import('js-tiktoken/ranks/o200k_base'),
  ]);
  return {
    LLMLingua2: lingua.LLMLingua2 as unknown as LinguaModule['LLMLingua2'],
    configure: (modelsDir) => {
      transformers.env.cacheDir = modelsDir;
    },
    createTokenizer: () => new tiktoken.Tiktoken(ranks.default),
  };
}

function hardSplit(piece: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of piece.split(/(\s+)/)) {
    if (current && countTokens(current + word) > CHUNK_TOKENS) {
      out.push(current);
      current = '';
    }
    current += word;
  }
  if (current.trim()) out.push(current);
  return out;
}

function splitOversized(paragraph: string): string[] {
  const pieces = paragraph.split(/\n|(?<=[.!?])\s+/).filter((p) => p.trim());
  return pieces.flatMap((p) => (countTokens(p) > CHUNK_TOKENS ? hardSplit(p) : [p]));
}

function packUnits(units: string[], separator: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? current + separator + unit : unit;
    if (current && countTokens(candidate) > CHUNK_TOKENS) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
  const units = paragraphs.flatMap((p) =>
    countTokens(p) > CHUNK_TOKENS ? packUnits(splitOversized(p), ' ') : [p],
  );
  return packUnits(units, '\n\n');
}

export function createLingua(opts: LinguaOptions): Lingua {
  const load = opts.load ?? defaultLoad;
  const modelsDir = join(opts.cacheDir, 'models');
  const state: LinguaStatus = { installed: true, model: 'tinybert', state: 'idle', progress: 0 };
  let module: LinguaModule | undefined;
  let initModel: LinguaModel | undefined;
  let initPromise: Promise<Compressor> | undefined;

  function onProgress(event: ProgressEvent): void {
    const aggregate = event.status === 'progress_total' || event.status === 'progress';
    if (!aggregate || typeof event.progress !== 'number') return;
    state.progress = Math.min(1, Math.max(0, event.progress / 100));
  }

  async function initialize(model: LinguaModel): Promise<Compressor> {
    state.model = model;
    state.state = 'downloading';
    state.progress = 0;
    try {
      if (!module) {
        try {
          module = (await load()) as LinguaModule;
        } catch (error) {
          state.installed = false;
          throw error;
        }
      }
      module.configure(modelsDir);
      const isXlm = model === 'xlm-roberta';
      const factory = isXlm ? module.LLMLingua2.WithXLMRoBERTa : module.LLMLingua2.WithBERTMultilingual;
      const { promptCompressor } = await factory(MODEL_IDS[model], {
        transformerJSConfig: { device: 'cpu', dtype: 'fp32' },
        oaiTokenizer: module.createTokenizer(),
        modelSpecificOptions: {
          progress_callback: onProgress,
          ...(isXlm ? { use_external_data_format: { 'model.onnx': 1 } } : {}),
        },
      });
      state.state = 'ready';
      state.progress = 1;
      return promptCompressor;
    } catch (error) {
      state.state = 'error';
      initPromise = undefined;
      initModel = undefined;
      throw error;
    }
  }

  function ensure(model: LinguaModel): Promise<Compressor> {
    if (!initPromise || initModel !== model) {
      initModel = model;
      initPromise = initialize(model);
    }
    return initPromise;
  }

  return {
    status: () => ({ ...state }),
    async compress(text, { rate, model = 'tinybert' }) {
      if (!(rate >= MIN_RATE && rate <= MAX_RATE)) {
        throw new RangeError(`rate must be between ${MIN_RATE} and ${MAX_RATE}`);
      }
      const chunks = chunkText(text);
      if (chunks.length === 0) return '';
      const compressor = await ensure(model);
      const out: string[] = [];
      for (const chunk of chunks) out.push(await compressor.compress(chunk, { rate }));
      return out.join('\n\n');
    },
  };
}
