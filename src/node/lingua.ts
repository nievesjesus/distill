import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from '../core/tokens';
import type { LinguaModel, LinguaStatus } from '../core/types';

export interface Lingua {
  status(): LinguaStatus;
  compress(text: string, opts: { rate: number; model?: LinguaModel; signal?: AbortSignal }): Promise<string>;
  probe(): Promise<boolean>;
}

export interface LinguaOptions {
  cacheDir: string;
  load?: () => Promise<unknown>;
  resolvePackages?: () => Promise<boolean>;
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

export function findPackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'distillmd') return dir;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function allowedModuleRoots(packageRoot: string): string[] {
  const realRoot = realpathSync(packageRoot);
  const roots = [join(realRoot, 'node_modules')];
  const parent = dirname(realRoot);
  const container = basename(parent).startsWith('@') ? dirname(parent) : parent;
  if (basename(container) === 'node_modules') roots.push(container);
  return roots;
}

export function resolveScoped(name: string, packageRoot: string): string | undefined {
  try {
    const resolved = createRequire(join(packageRoot, 'package.json')).resolve(name);
    const inside = allowedModuleRoots(packageRoot).some((root) => resolved.startsWith(root + sep));
    return inside ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function packagesInstalled(names: string[], packageRoot: string | undefined): boolean {
  if (!packageRoot) return false;
  return names.every((name) => resolveScoped(name, packageRoot) !== undefined);
}

const REQUIRED_PACKAGES = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'];

function distillRoot(): string | undefined {
  return findPackageRoot(dirname(fileURLToPath(import.meta.url)));
}

async function defaultLoad(): Promise<LinguaModule> {
  if (!packagesInstalled(REQUIRED_PACKAGES, distillRoot())) throw new Error('LLMLingua-2 packages are not installed');
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

async function defaultResolvePackages(): Promise<boolean> {
  return packagesInstalled(REQUIRED_PACKAGES, distillRoot());
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
  const resolvePackages = opts.resolvePackages ?? defaultResolvePackages;
  const modelsDir = join(opts.cacheDir, 'models');
  const state: LinguaStatus = { installed: true, model: 'tinybert', state: 'idle', progress: 0 };
  let module: LinguaModule | undefined;
  let current: { model: LinguaModel; promise: Promise<Compressor> } | undefined;

  function progressReporter(isCurrent: () => boolean): (event: ProgressEvent) => void {
    let sawTotal = false;
    return (event) => {
      if (!isCurrent() || typeof event.progress !== 'number') return;
      if (event.status === 'progress_total') sawTotal = true;
      else if (event.status !== 'progress' || sawTotal) return;
      state.progress = Math.max(state.progress, Math.min(1, Math.max(0, event.progress / 100)));
    };
  }

  async function initialize(model: LinguaModel, isCurrent: () => boolean): Promise<Compressor> {
    try {
      if (!module) {
        try {
          module = (await load()) as LinguaModule;
        } catch (error) {
          if (isCurrent()) state.installed = false;
          throw error;
        }
      }
      if (isCurrent()) state.installed = true;
      module.configure(modelsDir);
      const isXlm = model === 'xlm-roberta';
      const factory = isXlm ? module.LLMLingua2.WithXLMRoBERTa : module.LLMLingua2.WithBERTMultilingual;
      const { promptCompressor } = await factory(MODEL_IDS[model], {
        transformerJSConfig: { device: 'cpu', dtype: 'fp32' },
        oaiTokenizer: module.createTokenizer(),
        modelSpecificOptions: {
          progress_callback: progressReporter(isCurrent),
          ...(isXlm ? { use_external_data_format: { 'model.onnx': 1 } } : {}),
        },
      });
      if (isCurrent()) {
        state.state = 'ready';
        state.progress = 1;
      }
      return promptCompressor;
    } catch (error) {
      if (isCurrent()) {
        state.state = 'error';
        current = undefined;
      }
      throw error;
    }
  }

  function ensure(model: LinguaModel): Promise<Compressor> {
    if (current && current.model === model) return current.promise;
    state.model = model;
    state.state = 'downloading';
    state.progress = 0;
    const entry = { model, promise: undefined as unknown as Promise<Compressor> };
    current = entry;
    entry.promise = initialize(model, () => current === entry);
    return entry.promise;
  }

  return {
    status: () => ({ ...state }),
    async probe() {
      state.installed = await resolvePackages();
      return state.installed;
    },
    async compress(text, { rate, model = 'tinybert', signal }) {
      if (!(rate >= MIN_RATE && rate <= MAX_RATE)) {
        throw new RangeError(`rate must be between ${MIN_RATE} and ${MAX_RATE}`);
      }
      const chunks = chunkText(text);
      if (chunks.length === 0) return '';
      const compressor = await ensure(model);
      const out: string[] = [];
      for (const chunk of chunks) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        out.push(await compressor.compress(chunk, { rate }));
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return out.join('\n\n');
    },
  };
}
