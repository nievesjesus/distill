import { stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BOOSTER_ORDER } from '../core/boosters/pipeline';
import { type SavingsEstimate, estimateSavings, savingsNote, sumSavings } from '../core/savings';
import { countTokens } from '../core/tokens';
import type { DistillResult, Health, LocalBoosterId } from '../core/types';
import type { DistillOptions, Distiller } from '../node/distill';
import { DistillError } from '../node/errors';

const MAX_PATHS = 20;
const SERVER_NAME = 'distill-llm';
const DEFAULT_MAX_RESULT_TOKENS = 20000;
const CACHE_SIZE = 8;
const CHARS_PER_TOKEN = 4;
const PATH_HINT = "Absolute path, or relative to the server's working directory";
const SKIPPED_NOTE = 'Not included to stay under the size limit. Call distill_file with this path.';

const boostersSchema = z.array(z.enum(BOOSTER_ORDER as [LocalBoosterId, ...LocalBoosterId[]])).optional().describe('Boosters to apply: dedupe, media, tables, ws');
const linguaSchema = z.boolean().optional().describe('Compress further with LLMLingua-2 when installed');

const tokensSchema = z.object({ raw: z.number(), out: z.number() });
const savingsSchema = z.object({
  baseline: z.number(),
  out: z.number(),
  saved: z.number(),
  percent: z.number(),
  basis: z.enum(['pdf-pages', 'raw-text']),
});
const linesSchema = z.object({ from: z.number(), to: z.number(), total: z.number() });
const errorSchema = z.object({ code: z.string(), message: z.string() });

const linguaStatusSchema = z.object({
  installed: z.boolean(),
  installable: z.boolean(),
  model: z.string(),
  state: z.string(),
  progress: z.number(),
  installError: z.object({ code: z.string(), message: z.string() }).optional(),
  modelError: z.string().optional(),
  unsupportedReason: z.string().optional(),
});

export interface McpDeps {
  distiller: Distiller;
  health: () => Health;
  resolvePath: (path: string) => Promise<string>;
  savingsNote?: boolean;
  maxResultTokens?: number;
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
}

interface Page {
  markdown: string;
  from: number;
  to: number;
  total: number;
  truncated: boolean;
}

function splitLines(markdown: string): string[] {
  return markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function paginate(markdown: string, offset: number, budget: number): Page | null {
  const lines = splitLines(markdown);
  const total = lines.length;
  if (total === 0) return offset === 1 ? { markdown: '', from: 1, to: 0, total: 0, truncated: false } : null;
  if (offset > total) return null;
  let used = 0;
  let to = offset - 1;
  while (to < total) {
    const cost = countTokens(lines[to] as string);
    if (to >= offset && used + cost > budget) break;
    used += cost;
    to += 1;
  }
  let text = lines.slice(offset - 1, to).join('');
  const truncated = to === offset && used > budget;
  if (truncated) text = text.slice(0, budget * CHARS_PER_TOKEN);
  return { markdown: text, from: offset, to, total, truncated };
}

function continuationFor(page: Page): string {
  return `Showing lines ${page.from}-${page.to} of ${page.total}. Call distill_file again with offset ${page.to + 1} to continue.`;
}

function toOptions(args: { boosters?: LocalBoosterId[]; lingua?: boolean }): DistillOptions {
  const opts: DistillOptions = {};
  if (args.boosters !== undefined) opts.boosters = new Set(args.boosters);
  if (args.lingua !== undefined) opts.lingua = args.lingua;
  return opts;
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof DistillError) return { code: error.code, message: error.message };
  return { code: 'parse_failed', message: error instanceof Error ? error.message : String(error) };
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: deps.health().version });
  const withNote = deps.savingsNote !== false;

  const budget = deps.maxResultTokens !== undefined && deps.maxResultTokens > 0 ? deps.maxResultTokens : DEFAULT_MAX_RESULT_TOKENS;
  const statFile = deps.stat ?? stat;
  const cache = new Map<string, DistillResult>();

  async function cacheKey(resolved: string, args: { boosters?: LocalBoosterId[]; lingua?: boolean }): Promise<string | null> {
    try {
      const info = await statFile(resolved);
      return JSON.stringify([resolved, info.size, info.mtimeMs, [...(args.boosters ?? [])].sort(), args.lingua ?? null]);
    } catch {
      return null;
    }
  }

  async function distillOne(path: string, args: { boosters?: LocalBoosterId[]; lingua?: boolean }): Promise<DistillResult> {
    const resolved = await deps.resolvePath(path);
    const key = await cacheKey(resolved, args);
    const hit = key === null ? undefined : cache.get(key);
    if (key !== null && hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const result = await deps.distiller.distillFile(resolved, toOptions(args));
    if (key !== null) {
      cache.set(key, result);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    }
    return result;
  }

  server.registerTool(
    'distill_file',
    {
      description: 'Convert a document (PDF, DOCX, PPTX, XLSX, ODF, image) to token-lean Markdown; large documents come back in pages',
      inputSchema: {
        path: z.string().min(1).describe(PATH_HINT),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Line to start from, for documents too large to return at once; use the nextOffset from the previous call'),
        boosters: boostersSchema,
        lingua: linguaSchema,
      },
      outputSchema: {
        continuation: z.string().optional(),
        note: z.string().optional(),
        kind: z.string(),
        pages: z.number(),
        lines: linesSchema,
        nextOffset: z.number().optional(),
        truncated: z.boolean().optional(),
        tokens: tokensSchema,
        savings: savingsSchema.optional(),
        markdown: z.string(),
      },
    },
    async (args) => {
      try {
        const offset = args.offset ?? 1;
        const result = await distillOne(args.path, args);
        const page = paginate(result.markdown, offset, budget);
        if (page === null) {
          const total = splitLines(result.markdown).length;
          throw new DistillError('bad_request', `offset ${offset} is beyond the end of the document (${total} lines)`);
        }
        const more = page.to < page.total;
        const continuation = more ? continuationFor(page) : undefined;
        const savings = offset === 1 ? estimateSavings(result) : undefined;
        const note = withNote && savings ? savingsNote(savings) : undefined;
        const content: { type: 'text'; text: string }[] = [];
        if (continuation) content.push({ type: 'text', text: continuation });
        content.push({ type: 'text', text: page.markdown });
        if (note) content.push({ type: 'text', text: note });
        return {
          content,
          structuredContent: {
            ...(continuation ? { continuation } : {}),
            ...(note ? { note } : {}),
            kind: result.kind,
            pages: result.pages,
            lines: { from: page.from, to: page.to, total: page.total },
            ...(more ? { nextOffset: page.to + 1 } : {}),
            ...(page.truncated ? { truncated: true } : {}),
            tokens: result.tokens,
            ...(savings ? { savings } : {}),
            markdown: page.markdown,
          },
        };
      } catch (error) {
        const { code, message } = describeError(error);
        return { isError: true, content: [{ type: 'text' as const, text: `${code}: ${message}` }] };
      }
    },
  );

  server.registerTool(
    'distill_files',
    {
      description: `Convert up to ${MAX_PATHS} documents to token-lean Markdown; a failing file does not fail the call. Output is capped: a file that does not fit is returned in part and later files are skipped`,
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(MAX_PATHS).describe(`${PATH_HINT}, one per file`),
        boosters: boostersSchema,
        lingua: linguaSchema,
      },
      outputSchema: {
        continuation: z.string().optional(),
        results: z.array(
          z.union([
            z.object({
              path: z.string(),
              continuation: z.string().optional(),
              lines: linesSchema.optional(),
              nextOffset: z.number().optional(),
              truncated: z.boolean().optional(),
              tokens: tokensSchema,
              savings: savingsSchema,
              markdown: z.string(),
            }),
            z.object({ path: z.string(), skipped: z.literal(true), continuation: z.string() }),
            z.object({ path: z.string(), error: errorSchema }),
          ]),
        ),
        total: savingsSchema.nullable(),
        note: z.string().optional(),
      },
    },
    async (args) => {
      type Entry =
        | {
            path: string;
            continuation?: string;
            lines?: { from: number; to: number; total: number };
            nextOffset?: number;
            truncated?: boolean;
            tokens: { raw: number; out: number };
            savings: SavingsEstimate;
            markdown: string;
          }
        | { path: string; skipped: true; continuation: string }
        | { path: string; error: { code: string; message: string } };
      const results: Entry[] = [];
      const sections: string[] = [];
      const estimates: SavingsEstimate[] = [];
      let remaining = budget;
      let cut = false;
      let partial = 0;
      let skipped = 0;
      for (const path of args.paths) {
        const label = path.split(/[\\/]/).pop() ?? path;
        if (cut) {
          skipped += 1;
          results.push({ path, skipped: true, continuation: SKIPPED_NOTE });
          sections.push(`# ${label}\n\n${SKIPPED_NOTE}`);
          continue;
        }
        try {
          const result = await distillOne(path, args);
          const savings = estimateSavings(result);
          const cost = countTokens(result.markdown);
          if (cost <= remaining) {
            remaining -= cost;
            estimates.push(savings);
            results.push({ path, tokens: result.tokens, savings, markdown: result.markdown });
            sections.push(`# ${result.name}\n\n${result.markdown}`);
            continue;
          }
          const page = paginate(result.markdown, 1, remaining) as Page;
          cut = true;
          partial += 1;
          estimates.push(savings);
          const entry: Entry = {
            path,
            continuation: `Showing lines ${page.from}-${page.to} of ${page.total}. Call distill_file with this path and offset ${page.to + 1} to continue.`,
            lines: { from: page.from, to: page.to, total: page.total },
            ...(page.to < page.total ? { nextOffset: page.to + 1 } : {}),
            ...(page.truncated ? { truncated: true } : {}),
            tokens: result.tokens,
            savings,
            markdown: page.markdown,
          };
          results.push(entry);
          sections.push(`# ${result.name}\n\n${page.markdown}`);
        } catch (error) {
          const failure = describeError(error);
          results.push({ path, error: failure });
          sections.push(`# ${label}\n\n${failure.code}: ${failure.message}`);
        }
      }
      const total = estimates.length > 0 ? sumSavings(estimates) : null;
      const continuation =
        partial + skipped > 0
          ? `Output was capped to stay under the size limit: ${partial} file(s) returned in part, ${skipped} not included. Call distill_file with a path (and the offset in its continuation) to read the rest.`
          : undefined;
      const content: { type: 'text'; text: string }[] = [];
      if (continuation) content.push({ type: 'text', text: continuation });
      content.push({ type: 'text', text: sections.join('\n\n') });
      const note = withNote && total !== null ? savingsNote(total) : undefined;
      if (note) content.push({ type: 'text', text: note });
      return { content, structuredContent: { ...(continuation ? { continuation } : {}), results, total, ...(note ? { note } : {}) } };
    },
  );

  server.registerTool(
    'distill_capabilities',
    {
      description: 'Report versions, limits and available features (LibreOffice, LLMLingua-2)',
      outputSchema: {
        version: z.string(),
        liteparseVersion: z.string(),
        libreoffice: z.boolean(),
        lingua: linguaStatusSchema,
        maxBytes: z.number(),
      },
    },
    async () => {
      const health = deps.health();
      return { content: [{ type: 'text' as const, text: JSON.stringify(health) }], structuredContent: { ...health } };
    },
  );

  return server;
}
