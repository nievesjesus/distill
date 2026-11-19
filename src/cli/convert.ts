import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { parseBoosterList } from '../core/booster-list';
import { savedPercent, shortCount } from '../core/format';
import { buildOutline, fitLines, renderOutline, sliceLines } from '../core/outline';
import { type SavingsEstimate, estimateSavings, savingsNote } from '../core/savings';
import type { LocalBoosterId } from '../core/types';
import type { Distiller } from '../node/distill';
import { DistillError } from '../node/errors';

const CONCURRENCY = 4;

export interface ConvertOptions {
  out?: string;
  optimize: boolean;
  boosters?: Set<LocalBoosterId>;
  lingua?: boolean;
  rate?: number;
  json?: boolean;
  stdout?: boolean;
  offset?: number;
  limit?: number;
  maxTokens?: number;
  maxSize: number;
  allowPrivate?: boolean;
  allowHost?: string[];
}

export interface OutlineOptions {
  json?: boolean;
  maxSize: number;
  allowPrivate?: boolean;
  allowHost?: string[];
}

export interface ConvertIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  savingsNote?: boolean;
  recordUsage?: (kind: string, savings: SavingsEstimate) => void;
  openDistiller: (maxBytes: number) => Promise<Distiller>;
}

type Outcome =
  | { input: string; output?: string; tokens: { raw: number; out: number }; pages: number; ms: number; engine?: string }
  | { input: string; error: { code: string; message: string } };

export function parseBoosters(value: string): Set<LocalBoosterId> {
  try {
    return parseBoosterList(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

export function parseRate(value: string): number {
  const rate = Number(value);
  if (value.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new InvalidArgumentError('must be a number between 0 and 1');
  }
  return rate;
}

export function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return Number(value);
}

const HEAD_TOKENS = 2000;
const URL_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_URL_BASE = 80;

export function isUrlInput(input: string): boolean {
  return URL_PREFIX.test(input);
}

function urlBase(input: string): string {
  let base = 'page';
  try {
    const url = new URL(input);
    const segment = url.pathname.split('/').filter((part) => part !== '').pop();
    base = segment ? decodeURIComponent(segment).replace(/\.[A-Za-z0-9]{1,5}$/, '') : url.hostname;
  } catch {}
  const clean = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, MAX_URL_BASE);
  return clean === '' ? 'page' : clean;
}

function webOptions(options: { allowPrivate?: boolean; allowHost?: string[] }) {
  return {
    robots: 'ignore' as const,
    ...(options.allowPrivate ? { allowPrivate: true } : {}),
    ...(options.allowHost && options.allowHost.length > 0 ? { allowHosts: options.allowHost } : {}),
  };
}

function usageError(options: ConvertOptions, files: string[]): string | undefined {
  if (options.boosters !== undefined && !options.optimize) return '--boosters cannot be combined with --no-optimize';
  if (options.stdout && files.length > 1) return '--stdout accepts a single file';
  if (options.stdout && options.json) return '--stdout cannot be combined with --json';
  const sliced = options.offset !== undefined || options.limit !== undefined;
  if ((sliced || options.maxTokens !== undefined) && !options.stdout) return '--offset, --limit and --max-tokens require --stdout';
  if (sliced && options.maxTokens !== undefined) return '--max-tokens cannot be combined with --offset or --limit';
  return undefined;
}

function planDestinations(files: string[], out: string | undefined): string[] {
  const taken = new Set<string>();
  return files.map((file) => {
    const web = isUrlInput(file);
    const base = web ? urlBase(file) : basename(file, extname(file));
    const folder = out ?? (web ? '.' : dirname(file));
    let candidate = join(folder, `${base}.md`);
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = join(folder, `${base}-${n}.md`);
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function failure(input: string, error: unknown): Outcome {
  if (error instanceof DistillError) return { input, error: { code: error.code, message: error.message } };
  return { input, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } };
}

function stdoutText(markdown: string, name: string, input: string, tokens: number, options: ConvertOptions): string {
  if (options.offset !== undefined || options.limit !== undefined) return sliceLines(markdown, options.offset ?? 1, options.limit).text;
  if (options.maxTokens === undefined || tokens <= options.maxTokens) return markdown;
  const outline = renderOutline(buildOutline(markdown), { name });
  const shown = fitLines(markdown, Math.min(options.maxTokens, HEAD_TOKENS));
  const head = sliceLines(markdown, 1, shown);
  const hint = `[distill] Showing lines 1-${head.to} of ${head.total}. Read more with: distill-llm convert --stdout --offset <line> --limit <lines> "${input}"`;
  return `${outline}\n\n${head.text}\n\n${hint}`;
}

export async function runConvert(files: string[], options: ConvertOptions, io: ConvertIo): Promise<number> {
  const problem = usageError(options, files);
  if (problem !== undefined) {
    io.stderr(`error: ${problem}`);
    return 2;
  }

  const boosters = options.optimize ? options.boosters : new Set<LocalBoosterId>();
  const destinations = planDestinations(files, options.out);
  const outcomes: Outcome[] = new Array(files.length);
  let distiller: Distiller;
  try {
    distiller = await io.openDistiller(Math.round(options.maxSize * 1024 * 1024));
  } catch (error) {
    if (options.json) {
      io.stdout(JSON.stringify(files.map((input) => failure(input, error))));
    } else {
      io.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }

  async function convertOne(index: number): Promise<void> {
    const input = files[index];
    try {
      const settings = { boosters, lingua: options.lingua ?? false, rate: options.rate };
      const result = isUrlInput(input) ? await distiller.distillUrl(input, { ...settings, ...webOptions(options) }) : await distiller.distillFile(input, settings);
      try {
        io.recordUsage?.(result.kind, estimateSavings(result));
      } catch {}
      if (options.stdout) {
        io.stdout(stdoutText(result.markdown, result.name, input, result.tokens.out, options));
        if (io.savingsNote !== false) io.stderr(savingsNote(estimateSavings(result)));
        outcomes[index] = { input, tokens: result.tokens, pages: result.pages, ms: result.ms, ...(result.engine ? { engine: result.engine } : {}) };
        return;
      }
      const output = destinations[index];
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, result.markdown);
      outcomes[index] = { input, output, tokens: result.tokens, pages: result.pages, ms: result.ms, ...(result.engine ? { engine: result.engine } : {}) };
      if (!options.json) {
        const { raw, out } = result.tokens;
        io.stdout(`${input} → ${output}  ${shortCount(raw)} → ${shortCount(out)} tokens (−${savedPercent(raw, out)}%)`);
      }
    } catch (error) {
      const outcome = failure(input, error);
      outcomes[index] = outcome;
      if (!options.json && 'error' in outcome) io.stderr(`${input}  error: ${outcome.error.code}: ${outcome.error.message}`);
    }
  }

  try {
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (next < files.length) await convertOne(next++);
    });
    await Promise.all(workers);
  } finally {
    distiller.close();
  }

  if (options.json) io.stdout(JSON.stringify(outcomes));
  return outcomes.some((outcome) => 'error' in outcome) ? 1 : 0;
}

export async function runOutline(file: string, options: OutlineOptions, io: ConvertIo): Promise<number> {
  let distiller: Distiller;
  try {
    distiller = await io.openDistiller(Math.round(options.maxSize * 1024 * 1024));
  } catch (error) {
    if (options.json) io.stdout(JSON.stringify(failure(file, error)));
    else io.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const result = isUrlInput(file) ? await distiller.distillUrl(file, { lingua: false, ...webOptions(options) }) : await distiller.distillFile(file, { lingua: false });
    const outline = buildOutline(result.markdown);
    if (options.json) {
      io.stdout(JSON.stringify({ kind: result.kind, pages: result.pages, lines: outline.lines, tokens: outline.tokens, entries: outline.entries }));
    } else {
      io.stdout(renderOutline(outline, { name: result.name }));
    }
    return 0;
  } catch (error) {
    const outcome = failure(file, error);
    if (options.json) io.stdout(JSON.stringify(outcome));
    else if ('error' in outcome) io.stderr(`${file}  error: ${outcome.error.code}: ${outcome.error.message}`);
    return 1;
  } finally {
    distiller.close();
  }
}
