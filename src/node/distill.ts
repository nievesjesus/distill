import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACTIVE, runBoosters } from '../core/boosters/pipeline';
import { detectKind, needsLibreOfficeFor } from '../core/kind';
import { countTokens } from '../core/tokens';
import type { AsrStatus, DistillResult, Health, LinguaStatus, LocalBoosterId } from '../core/types';
import { exposeLibreOffice } from './capabilities';
import { DistillError } from './errors';
import { cacheDirFromEnv } from './cache-dir';
import { DEFAULT_MAX_BYTES, maxBytesFor } from './limits';
import { createLingua, findPackageRoot } from './lingua';
import type { Lingua } from './lingua';
import { getAsrStatus } from './asr-install';
import { createLinguaInstaller } from './lingua-install';
import { withMedia } from './asr/media';
import { withBuiltinOffice } from './office';
import { createParser } from './parse';
import type { Parser } from './parse';
import { createWebCache } from './web/cache';
import { createUrlDistiller } from './web/distill-url';
import type { UrlOptions } from './web/distill-url';
import { fetchUrl } from './web/fetch';
import type { FetchOptions, FetchResult } from './web/fetch';
import { withSavedFormats } from './web/saved';

const DEFAULT_RATE = 0.5;
const PAGE_IMAGE_DPI = 100;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const NO_LINGUA: LinguaStatus = { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 };
const LINGUA_NOT_INSTALLED = 'LLMLingua-2 is not installed. Install it once from the web app (npx distill-llm).';

export interface DistillOptions {
  mode?: 'clean' | 'full';
  boosters?: ReadonlySet<LocalBoosterId>;
  lingua?: boolean;
  rate?: number;
  timestamps?: 'none' | 'coarse' | 'segment';
  frames?: 'none' | 'ocr';
  signal?: AbortSignal;
}

export interface DistillUrlOptions extends DistillOptions {
  allowPrivate?: boolean;
  allowHosts?: readonly string[];
  robots?: 'ignore' | 'respect';
}

export interface RenderedPage {
  image: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface Distiller {
  distillFile(path: string, opts?: DistillOptions): Promise<DistillResult>;
  distillUrl(url: string, opts?: DistillUrlOptions): Promise<DistillResult>;
  renderPage(path: string, page: number): Promise<RenderedPage>;
  health(): Health;
  close(): void;
}

export function createDistiller(deps: {
  parser: Parser;
  lingua?: Lingua;
  asrStatus?: () => AsrStatus;
  libreoffice: boolean;
  maxBytes?: number;
  version?: string;
  liteparseVersion?: string;
  fetchUrl?: (url: string, options: FetchOptions) => Promise<FetchResult>;
  webCacheDir?: string;
  now?: () => number;
}): Distiller {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  function linguaFor(opts: DistillOptions) {
    const lingua = opts.lingua ? deps.lingua : undefined;
    if (opts.lingua && !lingua?.status().installed) throw new DistillError('lingua_unavailable', lingua?.status().unsupportedReason ?? LINGUA_NOT_INSTALLED);
    return lingua;
  }

  async function polish(markdown: string, opts: DistillOptions): Promise<string> {
    const boosted = runBoosters(markdown, opts.boosters ?? DEFAULT_ACTIVE);
    const lingua = linguaFor(opts);
    return lingua ? await lingua.compress(boosted, { rate: opts.rate ?? DEFAULT_RATE }) : boosted;
  }

  async function sizeOf(path: string): Promise<number> {
    try {
      const info = await stat(path);
      if (info.isFile()) return info.size;
    } catch {
      throw new DistillError('not_found', `File not found: ${path}`);
    }
    throw new DistillError('not_found', `Not a file: ${path}`);
  }

  const distillUrlImpl = createUrlDistiller({
    fetch: deps.fetchUrl ?? fetchUrl,
    ...(deps.webCacheDir ? { cache: createWebCache(deps.webCacheDir) } : {}),
    version: deps.version ?? '',
    now: deps.now ?? Date.now,
    checkLingua: (opts: UrlOptions) => void linguaFor(opts),
    polish: (markdown: string, opts: UrlOptions) => polish(markdown, opts),
    distillDocument: (path: string, opts: UrlOptions) => distiller.distillFile(path, opts),
  });

  const distiller: Distiller = {
    async distillFile(path, opts = {}) {
      const size = await sizeOf(path);
      const name = basename(path);
      const kind = detectKind(name);
      if (!kind) throw new DistillError('unsupported_type', 'Unsupported file type');
      const limit = maxBytesFor(name, maxBytes);
      if (size > limit) throw new DistillError('too_large', `File exceeds the ${limit} byte limit`);
      if (needsLibreOfficeFor(name) && !deps.libreoffice) {
        throw new DistillError('needs_libreoffice', 'LibreOffice is required to read this file type');
      }
      linguaFor(opts);

      const started = performance.now();
      const parseOptions = {
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.timestamps ? { timestamps: opts.timestamps } : {}),
        ...(opts.frames ? { frames: opts.frames } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      const parsed = await deps.parser.toMarkdown(path, Object.keys(parseOptions).length > 0 ? parseOptions : undefined);
      const markdown = await polish(parsed.markdown, opts);
      return {
        path,
        name,
        kind,
        pages: parsed.pages,
        markdown,
        tokens: { raw: parsed.rawTokens ?? countTokens(parsed.markdown), out: countTokens(markdown) },
        ms: Math.round(performance.now() - started),
        ...(parsed.engine ? { engine: parsed.engine } : {}),
        ...(parsed.visualPages ? { visualPages: parsed.visualPages } : {}),
      };
    },
    distillUrl: (url, opts = {}) => distillUrlImpl(url, opts),
    async renderPage(path, page) {
      if (!Number.isInteger(page) || page < 1) throw new DistillError('bad_request', 'page must be a whole number from 1');
      const size = await sizeOf(path);
      const name = basename(path);
      const kind = detectKind(name);
      if (!kind) throw new DistillError('unsupported_type', 'Unsupported file type');
      if (size > maxBytes) throw new DistillError('too_large', `File exceeds the ${maxBytes} byte limit`);
      if (kind === 'PDF') {
        const rendered = await deps.parser.renderPage(path, page, { dpi: PAGE_IMAGE_DPI });
        return { image: rendered.png, mimeType: 'image/png', width: rendered.width, height: rendered.height };
      }
      const mimeType = IMAGE_MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
      if (kind !== 'IMG' || mimeType === undefined) {
        throw new DistillError('bad_request', 'Only PDF pages and PNG, JPG or WebP images can be shown');
      }
      if (page !== 1) throw new DistillError('bad_request', 'An image has a single page: pass page 1');
      return { image: await readFile(path), mimeType };
    },
    health: () => ({
      version: deps.version ?? '',
      liteparseVersion: deps.liteparseVersion ?? '',
      libreoffice: deps.libreoffice,
      lingua: deps.lingua?.status() ?? NO_LINGUA,
      ...(deps.asrStatus ? { asr: deps.asrStatus() } : {}),
      maxBytes,
    }),
    close: () => deps.parser.close(),
  };
  return distiller;
}

function readVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

export async function openDistiller(maxBytes?: number): Promise<Distiller> {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot === undefined) throw new Error('distill-llm package.json not found');
  const require = createRequire(import.meta.url);
  const version = readVersion(join(packageRoot, 'package.json'));
  const liteparseVersion = readVersion(require.resolve('@llamaindex/liteparse/package.json'));
  const libreoffice = await exposeLibreOffice();
  const cacheDir = join(homedir(), '.cache', 'distill-llm');
  const asrCacheDir = cacheDirFromEnv(process.env) ?? cacheDir;
  const parser = withMedia(withSavedFormats(withBuiltinOffice(createParser(), { libreoffice })), { cacheDir: asrCacheDir });
  try {
    const installer = createLinguaInstaller({ cacheDir, runtimeDir: join(packageRoot, 'lingua-runtime') });
    const lingua = createLingua({ cacheDir, installer });
    await lingua.probe();
    return createDistiller({ parser, lingua, asrStatus: () => getAsrStatus({ cacheDir: asrCacheDir }), libreoffice, maxBytes, version, liteparseVersion, webCacheDir: join(cacheDir, 'web') });
  } catch (error) {
    parser.close();
    throw error;
  }
}
