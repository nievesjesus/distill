import { stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BOOSTER_ORDER } from '../core/boosters/pipeline';
import { type Outline, buildOutline, renderOutline } from '../core/outline';
import { type SavingsEstimate, estimateSavings, savingsNote, sumSavings } from '../core/savings';
import { countTokens } from '../core/tokens';
import type { DistillResult, Health, LocalBoosterId } from '../core/types';
import type { DistillOptions, Distiller } from '../node/distill';
import { DistillError } from '../node/errors';

const MAX_PATHS = 20;
const SERVER_NAME = 'distill-llm';
const DEFAULT_MAX_RESULT_TOKENS = 10000;
const CACHE_SIZE = 8;
const CHARS_PER_TOKEN = 4;
const PATH_HINT = "Absolute path, or relative to the server's working directory";
const SKIPPED_NOTE = 'Not included to stay under the size limit. Call distill_file with this path.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const boostersSchema = z
  .array(z.enum(BOOSTER_ORDER as [LocalBoosterId, ...LocalBoosterId[]]))
  .optional()
  .describe(
    'Lossless cleanups to apply, default all: dedupe (repeated headers and footers), media (shorter image paths and link URLs), tables (removes padding), ws (collapses whitespace). Pass a subset to keep, for example, link URLs',
  );
const linguaSchema = z
  .boolean()
  .optional()
  .describe('Optional LLMLingua-2 compression, lossy: it removes words. Only works when installed (see distill_capabilities); avoid it for contracts and other exact text');
const entrySchema = z.object({
  kind: z.enum(['heading', 'page', 'start']),
  level: z.number(),
  title: z.string(),
  line: z.number(),
  endLine: z.number(),
  tokens: z.number(),
  page: z.string().optional(),
});

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function stripHashes(text: string): string {
  return text.replace(/^[#\s]+/, '').trim().toLowerCase();
}

function findSection(outline: Outline, section: string): { line: number; endLine: number } | null {
  const wanted = stripHashes(section);
  const titles = outline.entries.map((entry) => ({ entry, title: stripHashes(entry.title) }));
  const match = titles.find((item) => item.title === wanted) ?? titles.find((item) => wanted !== '' && item.title.includes(wanted));
  return match ? { line: match.entry.line, endLine: match.entry.endLine } : null;
}

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
  end: number;
}

function splitLines(markdown: string): string[] {
  return markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function paginate(markdown: string, offset: number, budget: number, limit?: number): Page | null {
  const lines = splitLines(markdown);
  const total = lines.length;
  if (total === 0) return offset === 1 ? { markdown: '', from: 1, to: 0, total: 0, truncated: false, end: 0 } : null;
  if (offset > total) return null;
  const end = limit === undefined ? total : Math.min(total, offset + limit - 1);
  let used = 0;
  let to = offset - 1;
  while (to < end) {
    const cost = countTokens(lines[to] as string);
    if (to >= offset && used + cost > budget) break;
    used += cost;
    to += 1;
  }
  let text = lines.slice(offset - 1, to).join('');
  const truncated = to === offset && used > budget;
  if (truncated) text = text.slice(0, budget * CHARS_PER_TOKEN);
  return { markdown: text, from: offset, to, total, truncated, end };
}

function continuationFor(page: Page, windowed: boolean): string {
  const rest = windowed ? ` and limit ${page.end - page.to}` : '';
  return `Showing lines ${page.from}-${page.to} of ${page.total}. Call distill_file again with offset ${page.to + 1}${rest} to continue.`;
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

  const maxSize = formatLimit(deps.health().maxBytes);

  server.registerTool(
    'distill_file',
    {
      title: 'Read a document as Markdown',
      description: `Read one local document (PDF, DOCX, PPTX, XLSX, ODT/ODS/ODP, CSV, PNG/JPG/TIFF/WebP) as token-lean Markdown. Read-only: never modifies or uploads the file. Use distill_files for several files at once and distill_outline first for long documents, then pass \`section\` or \`offset\`/\`limit\`. Output is capped at about ${budget} tokens per call; follow \`nextOffset\`. Fails with password_protected, needs_libreoffice (legacy .doc/.xls/.ppt and OpenDocument), forbidden (outside allowed roots), too_large (over ${maxSize}) or parse_failed. Tables and scans are only as faithful as the parser; check charts in the original.`,
      annotations: READ_ONLY,
      inputSchema: {
        path: z.string().min(1).describe(PATH_HINT),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Line to start from (1-based), for documents too large to return at once; use the nextOffset from the previous call or a line from distill_outline'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of lines to read from offset (or from line 1); paging stays inside this window'),
        section: z
          .string()
          .optional()
          .describe('Title of a section from distill_outline (case-insensitive; exact match first, then substring). Reads just that section; cannot be combined with offset'),
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
        outline: z.string().optional(),
        markdown: z.string(),
      },
    },
    async (args) => {
      try {
        if (args.section !== undefined && args.offset !== undefined) {
          throw new DistillError('bad_request', 'Pass either section or offset, not both');
        }
        const result = await distillOne(args.path, args);
        let offset = args.offset ?? 1;
        let limit = args.limit;
        if (args.section !== undefined) {
          const found = findSection(buildOutline(result.markdown), args.section);
          if (found === null) {
            throw new DistillError('bad_request', `No section matches "${args.section}". Call distill_outline to list sections.`);
          }
          offset = found.line;
          limit = found.endLine - found.line + 1;
        }
        const page = paginate(result.markdown, offset, budget, limit);
        if (page === null) {
          const total = splitLines(result.markdown).length;
          throw new DistillError('bad_request', `offset ${offset} is beyond the end of the document (${total} lines)`);
        }
        const more = page.to < page.end;
        const continuation = more ? continuationFor(page, limit !== undefined) : undefined;
        const savings = offset === 1 && args.section === undefined ? estimateSavings(result) : undefined;
        const note = withNote && savings ? savingsNote(savings) : undefined;
        const partialStart = args.offset === undefined && args.limit === undefined && args.section === undefined && page.to < page.total;
        const outline = partialStart ? renderOutline(buildOutline(result.markdown), { name: result.name }) : undefined;
        const content: { type: 'text'; text: string }[] = [];
        if (continuation) content.push({ type: 'text', text: continuation });
        if (outline) content.push({ type: 'text', text: outline });
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
            ...(outline ? { outline } : {}),
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
    'distill_outline',
    {
      title: 'Index a document by section',
      description: `Index one local document (same formats as distill_file) without reading it: a table of contents with line ranges, page numbers and token counts per section. Read-only: never modifies or uploads the file. Call it first for long documents, then read only what you need with distill_file using \`section\` or \`offset\`/\`limit\`. Line numbers refer to the converted Markdown, not to the original file. Small and unstructured documents get a single entry. Fails like distill_file (password_protected, needs_libreoffice, forbidden, too_large over ${maxSize}, parse_failed).`,
      annotations: READ_ONLY,
      inputSchema: {
        path: z.string().min(1).describe(PATH_HINT),
        boosters: boostersSchema,
        lingua: linguaSchema,
      },
      outputSchema: {
        note: z.string().optional(),
        outline: z.string(),
        kind: z.string(),
        pages: z.number(),
        lines: z.number(),
        tokens: z.number(),
        entries: z.array(entrySchema),
      },
    },
    async (args) => {
      try {
        const result = await distillOne(args.path, args);
        const outline = buildOutline(result.markdown);
        const text = renderOutline(outline, { name: result.name });
        const note = withNote ? savingsNote(estimateSavings(result)) : undefined;
        const content: { type: 'text'; text: string }[] = [{ type: 'text', text }];
        if (note) content.push({ type: 'text', text: note });
        return {
          content,
          structuredContent: {
            ...(note ? { note } : {}),
            outline: text,
            kind: result.kind,
            pages: result.pages,
            lines: outline.lines,
            tokens: outline.tokens,
            entries: outline.entries,
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
      title: 'Read several documents as Markdown',
      description: `Read up to ${MAX_PATHS} local documents (same formats as distill_file) as token-lean Markdown in one call. Read-only: never modifies or uploads files. A failing file is reported per file and does not fail the call. Total output is capped at about ${budget} tokens: a file that does not fit is returned in part and later files are skipped; read those with distill_file (use distill_outline first for long ones). Prefer distill_file for a single document.`,
      annotations: READ_ONLY,
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
      title: 'Report distill capabilities',
      description: `Report the server version, the maximum file size in bytes (maxBytes), the per-call output cap in tokens (maxResultTokens) and which optional features are available (LibreOffice for legacy .doc/.xls/.ppt and OpenDocument, LLMLingua-2 for the lossy lingua option). Read-only and cheap; call it when a conversion fails with needs_libreoffice or before using lingua. Does not read any document.`,
      annotations: READ_ONLY,
      outputSchema: {
        version: z.string(),
        liteparseVersion: z.string(),
        libreoffice: z.boolean(),
        lingua: linguaStatusSchema,
        maxBytes: z.number(),
        maxResultTokens: z.number(),
      },
    },
    async () => {
      const health = { ...deps.health(), maxResultTokens: budget };
      return { content: [{ type: 'text' as const, text: JSON.stringify(health) }], structuredContent: health };
    },
  );

  return server;
}
