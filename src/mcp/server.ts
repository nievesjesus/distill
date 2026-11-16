import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BOOSTER_ORDER } from '../core/boosters/pipeline';
import { type SavingsEstimate, estimateSavings, savingsNote, sumSavings } from '../core/savings';
import type { Health, LocalBoosterId } from '../core/types';
import type { DistillOptions, Distiller } from '../node/distill';
import { DistillError } from '../node/errors';

const MAX_PATHS = 20;
const SERVER_NAME = 'distill-llm';

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

  async function distillOne(path: string, args: { boosters?: LocalBoosterId[]; lingua?: boolean }) {
    const resolved = await deps.resolvePath(path);
    return deps.distiller.distillFile(resolved, toOptions(args));
  }

  server.registerTool(
    'distill_file',
    {
      description: 'Convert a document (PDF, DOCX, PPTX, XLSX, ODF, image) to token-lean Markdown',
      inputSchema: { path: z.string().min(1).describe('Path of the file to convert'), boosters: boostersSchema, lingua: linguaSchema },
      outputSchema: { markdown: z.string(), tokens: tokensSchema, pages: z.number(), kind: z.string(), savings: savingsSchema, note: z.string().optional() },
    },
    async (args) => {
      try {
        const result = await distillOne(args.path, args);
        const savings = estimateSavings(result);
        const content = [{ type: 'text' as const, text: result.markdown }];
        if (withNote) content.push({ type: 'text' as const, text: savingsNote(savings) });
        return {
          content,
          structuredContent: {
            markdown: result.markdown,
            tokens: result.tokens,
            pages: result.pages,
            kind: result.kind,
            savings,
            ...(withNote ? { note: savingsNote(savings) } : {}),
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
      description: `Convert up to ${MAX_PATHS} documents to token-lean Markdown; a failing file does not fail the call`,
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(MAX_PATHS).describe('Paths of the files to convert'),
        boosters: boostersSchema,
        lingua: linguaSchema,
      },
      outputSchema: {
        results: z.array(
          z.union([
            z.object({ path: z.string(), markdown: z.string(), tokens: tokensSchema, savings: savingsSchema }),
            z.object({ path: z.string(), error: errorSchema }),
          ]),
        ),
        total: savingsSchema.nullable(),
        note: z.string().optional(),
      },
    },
    async (args) => {
      const results: ({ path: string; markdown: string; tokens: { raw: number; out: number }; savings: SavingsEstimate } | { path: string; error: { code: string; message: string } })[] = [];
      const sections: string[] = [];
      const estimates: SavingsEstimate[] = [];
      for (const path of args.paths) {
        try {
          const result = await distillOne(path, args);
          const savings = estimateSavings(result);
          estimates.push(savings);
          results.push({ path, markdown: result.markdown, tokens: result.tokens, savings });
          sections.push(`# ${result.name}\n\n${result.markdown}`);
        } catch (error) {
          const failure = describeError(error);
          results.push({ path, error: failure });
          sections.push(`# ${path.split(/[\\/]/).pop() ?? path}\n\n${failure.code}: ${failure.message}`);
        }
      }
      const total = estimates.length > 0 ? sumSavings(estimates) : null;
      const content = [{ type: 'text' as const, text: sections.join('\n\n') }];
      if (withNote && total !== null) content.push({ type: 'text' as const, text: savingsNote(total) });
      return { content, structuredContent: { results, total, ...(withNote && total !== null ? { note: savingsNote(total) } : {}) } };
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
