import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACTIVE, runBoosters } from '../core/boosters/pipeline';
import { detectKind, needsLibreOffice } from '../core/kind';
import { countTokens } from '../core/tokens';
import type { DistillResult, Health, LinguaStatus, LocalBoosterId } from '../core/types';
import { exposeLibreOffice } from './capabilities';
import { DistillError } from './errors';
import { createLingua, findPackageRoot } from './lingua';
import type { Lingua } from './lingua';
import { createLinguaInstaller } from './lingua-install';
import { createParser } from './parse';
import type { Parser } from './parse';

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_RATE = 0.5;
const NO_LINGUA: LinguaStatus = { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 };
const LINGUA_NOT_INSTALLED = 'LLMLingua-2 is not installed. Install it once from the web app (npx distillmd).';

export interface DistillOptions {
  boosters?: ReadonlySet<LocalBoosterId>;
  lingua?: boolean;
  rate?: number;
}

export interface Distiller {
  distillFile(path: string, opts?: DistillOptions): Promise<DistillResult>;
  health(): Health;
  close(): void;
}

export function createDistiller(deps: {
  parser: Parser;
  lingua?: Lingua;
  libreoffice: boolean;
  maxBytes?: number;
  version?: string;
  liteparseVersion?: string;
}): Distiller {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  async function sizeOf(path: string): Promise<number> {
    try {
      const info = await stat(path);
      if (info.isFile()) return info.size;
    } catch {
      throw new DistillError('not_found', `File not found: ${path}`);
    }
    throw new DistillError('not_found', `Not a file: ${path}`);
  }

  return {
    async distillFile(path, opts = {}) {
      const size = await sizeOf(path);
      const name = basename(path);
      const kind = detectKind(name);
      if (!kind) throw new DistillError('unsupported_type', 'Unsupported file type');
      if (size > maxBytes) throw new DistillError('too_large', `File exceeds the ${maxBytes} byte limit`);
      if (needsLibreOffice(kind) && !deps.libreoffice) {
        throw new DistillError('needs_libreoffice', 'LibreOffice is required to read this file type');
      }
      const lingua = opts.lingua ? deps.lingua : undefined;
      if (opts.lingua && !lingua?.status().installed) throw new DistillError('lingua_unavailable', LINGUA_NOT_INSTALLED);

      const started = performance.now();
      const parsed = await deps.parser.toMarkdown(path);
      const boosted = runBoosters(parsed.markdown, opts.boosters ?? DEFAULT_ACTIVE);
      const markdown = lingua ? await lingua.compress(boosted, { rate: opts.rate ?? DEFAULT_RATE }) : boosted;
      return {
        path,
        name,
        kind,
        pages: parsed.pages,
        markdown,
        tokens: { raw: countTokens(parsed.markdown), out: countTokens(markdown) },
        ms: Math.round(performance.now() - started),
      };
    },
    health: () => ({
      version: deps.version ?? '',
      liteparseVersion: deps.liteparseVersion ?? '',
      libreoffice: deps.libreoffice,
      lingua: deps.lingua?.status() ?? NO_LINGUA,
      maxBytes,
    }),
    close: () => deps.parser.close(),
  };
}

function readVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

export async function openDistiller(maxBytes?: number): Promise<Distiller> {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot === undefined) throw new Error('distillmd package.json not found');
  const require = createRequire(import.meta.url);
  const version = readVersion(join(packageRoot, 'package.json'));
  const liteparseVersion = readVersion(require.resolve('@llamaindex/liteparse/package.json'));
  const libreoffice = await exposeLibreOffice();
  const parser = createParser();
  try {
    const cacheDir = join(homedir(), '.cache', 'distillmd');
    const installer = createLinguaInstaller({ cacheDir, runtimeDir: join(packageRoot, 'lingua-runtime') });
    const lingua = createLingua({ cacheDir, installer });
    await lingua.probe();
    return createDistiller({ parser, lingua, libreoffice, maxBytes, version, liteparseVersion });
  } catch (error) {
    parser.close();
    throw error;
  }
}
