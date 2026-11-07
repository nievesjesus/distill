import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { countTokens } from '../core/tokens';
import type { LinguaModel, LinguaStatus } from '../core/types';
import type { LinguaInstaller } from './lingua-install';

export interface Lingua {
  status(): LinguaStatus;
  compress(text: string, opts: { rate: number; model?: LinguaModel; signal?: AbortSignal }): Promise<string>;
  probe(): Promise<boolean>;
  install(): Promise<void>;
}

export interface LinguaOptions {
  cacheDir: string;
  load?: () => Promise<unknown>;
  resolvePackages?: () => Promise<boolean>;
  roots?: () => string[];
  installer?: LinguaInstaller;
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

const CONDITIONS: ReadonlySet<string> = new Set(['node', 'import', 'default']);

function pickCondition(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const picked = pickCondition(entry);
      if (picked !== undefined) return picked;
    }
    return undefined;
  }
  if (typeof target === 'object' && target !== null) {
    for (const [key, value] of Object.entries(target)) {
      if (!CONDITIONS.has(key)) continue;
      const picked = pickCondition(value);
      if (picked !== undefined) return picked;
    }
  }
  return undefined;
}

function exportTarget(exportsField: unknown, subpath: string): string | undefined {
  const isSubpathMap = typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField) && Object.keys(exportsField).every((key) => key.startsWith('.'));
  if (isSubpathMap) return pickCondition((exportsField as Record<string, unknown>)[subpath]);
  return subpath === '.' ? pickCondition(exportsField) : undefined;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent + sep);
}

export function resolveInRoot(name: string, root: string, subpath = '.'): string | undefined {
  try {
    const realRoot = realpathSync(root);
    const realPackage = realpathSync(join(realRoot, 'node_modules', ...name.split('/')));
    if (!isInside(realPackage, realRoot)) return undefined;
    const manifest = JSON.parse(readFileSync(join(realPackage, 'package.json'), 'utf8')) as { name?: string; main?: string; exports?: unknown };
    if (manifest.name !== name) return undefined;
    let relative: string | undefined;
    if (manifest.exports !== undefined) relative = exportTarget(manifest.exports, subpath);
    else relative = subpath === '.' ? (manifest.main ?? 'index.js') : subpath;
    if (relative === undefined) return undefined;
    const entry = resolve(realPackage, relative);
    return isInside(entry, realPackage) && existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

const REQUIRED_PACKAGES = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'];

export function findLinguaRoot(roots: string[]): string | undefined {
  return roots.find((root) => REQUIRED_PACKAGES.every((name) => resolveInRoot(name, root) !== undefined));
}

export function linguaRoots(where: { packageRoot: string | undefined; resourcesPath: string | undefined; cacheDir: string }): string[] {
  const roots: string[] = [];
  if (where.packageRoot) roots.push(where.packageRoot);
  if (where.resourcesPath) roots.push(join(where.resourcesPath, 'lingua'));
  roots.push(join(where.cacheDir, 'lingua'));
  return roots;
}

function distillRoot(): string | undefined {
  return findPackageRoot(dirname(fileURLToPath(import.meta.url)));
}

function defaultRoots(cacheDir: string): string[] {
  return linguaRoots({
    packageRoot: distillRoot(),
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    cacheDir,
  });
}

async function loadFromRoot(root: string): Promise<LinguaModule> {
  const entry = (name: string, subpath = '.'): Promise<any> => {
    const resolved = resolveInRoot(name, root, subpath);
    if (resolved === undefined) throw new Error('LLMLingua-2 packages are not installed');
    return import(pathToFileURL(resolved).href);
  };
  const [lingua, transformers, tiktoken, ranks] = await Promise.all([
    entry('@atjsh/llmlingua-2'),
    entry('@huggingface/transformers'),
    entry('js-tiktoken', './lite'),
    entry('js-tiktoken', './ranks/o200k_base'),
  ]);
  return {
    LLMLingua2: lingua.LLMLingua2 as LinguaModule['LLMLingua2'],
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
  const roots = opts.roots ?? (() => defaultRoots(opts.cacheDir));
  const installer = opts.installer;
  const load =
    opts.load ??
    (async () => {
      const root = findLinguaRoot(roots());
      if (root === undefined) throw new Error('LLMLingua-2 packages are not installed');
      return loadFromRoot(root);
    });
  const resolvePackages = opts.resolvePackages ?? (async () => findLinguaRoot(roots()) !== undefined);
  const modelsDir = join(opts.cacheDir, 'models');
  const state: Omit<LinguaStatus, 'installable' | 'installError'> = { installed: true, model: 'tinybert', state: 'idle', progress: 0 };
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
    status() {
      const status: LinguaStatus = { ...state, installable: installer?.installable() ?? false };
      const installing = installer?.status();
      if (!state.installed && installing?.state === 'installing') status.state = 'installing';
      if (!state.installed && installing?.state === 'failed') {
        status.state = 'install_failed';
        status.installError = installing.error;
      }
      return status;
    },
    async probe() {
      await installer?.sweep();
      const found = await resolvePackages();
      state.installed = found;
      if (!found) await installer?.probe();
      return found;
    },
    async install() {
      if (!installer) throw new Error('LLMLingua-2 cannot be installed here');
      await installer.install();
      module = undefined;
      state.installed = await resolvePackages();
      if (state.installed) {
        state.state = 'idle';
        state.progress = 0;
        current = undefined;
      }
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
