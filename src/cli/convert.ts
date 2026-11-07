import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { parseBoosterList } from '../core/booster-list';
import { savedPercent, shortCount } from '../core/format';
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
  maxSize: number;
}

export interface ConvertIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openDistiller: (maxBytes: number) => Promise<Distiller>;
}

type Outcome =
  | { input: string; output?: string; tokens: { raw: number; out: number }; pages: number; ms: number }
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

function usageError(options: ConvertOptions, files: string[]): string | undefined {
  if (options.boosters !== undefined && !options.optimize) return '--boosters cannot be combined with --no-optimize';
  if (options.stdout && files.length > 1) return '--stdout accepts a single file';
  if (options.stdout && options.json) return '--stdout cannot be combined with --json';
  return undefined;
}

function planDestinations(files: string[], out: string | undefined): string[] {
  const taken = new Set<string>();
  return files.map((file) => {
    const base = basename(file, extname(file));
    const folder = out ?? dirname(file);
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
      const result = await distiller.distillFile(input, { boosters, lingua: options.lingua ?? false, rate: options.rate });
      if (options.stdout) {
        io.stdout(result.markdown);
        outcomes[index] = { input, tokens: result.tokens, pages: result.pages, ms: result.ms };
        return;
      }
      const output = destinations[index];
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, result.markdown);
      outcomes[index] = { input, output, tokens: result.tokens, pages: result.pages, ms: result.ms };
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
