import { availableParallelism } from 'node:os';
import { LiteParse, ParseTimeoutError } from '@llamaindex/liteparse';
import type { VisualKind, VisualPage } from '../core/types';
import { DistillError } from './errors';

export interface Parser {
  toMarkdown(path: string): Promise<{ markdown: string; pages: number; engine?: 'liteparse' | 'builtin'; visualPages?: VisualPage[] }>;
  toJson(path: string): Promise<unknown>;
  close(): void;
}

export interface PageComplexity {
  textLength?: number;
  fullPageImage: boolean;
  largestImageCoverage: number;
  uncoveredVectorArea?: number;
  layout?: { figureCount: number };
}

interface PageText {
  pageNum: number;
  pageLabel?: string;
  markdown: string;
  complexity?: PageComplexity;
}

const FIGURE_IMAGE_COVERAGE = 0.03;
const FIGURE_VECTOR_AREA = 1000;
const FIGURE_SPARSE_TEXT = 50;

export function classifyPage(complexity: PageComplexity | undefined, textLength: number): VisualKind | null {
  if (!complexity) return null;
  if (complexity.fullPageImage) return 'scan';
  if (complexity.largestImageCoverage >= FIGURE_IMAGE_COVERAGE) return 'figure';
  if ((complexity.uncoveredVectorArea ?? 0) >= FIGURE_VECTOR_AREA) return 'figure';
  if (textLength < FIGURE_SPARSE_TEXT && (complexity.layout?.figureCount ?? 0) > 0) return 'figure';
  return null;
}

const labelOf = (page: PageText): string => String(page.pageLabel ?? page.pageNum).replace(/\s+/g, '-');
const kindOf = (page: PageText): VisualKind | null => classifyPage(page.complexity, page.complexity?.textLength ?? page.markdown.length);

const MARKER_SUFFIX: Record<VisualKind, string> = {
  figure: ': figure (chart or image not in this text; see the original page)',
  scan: ': scan (OCR text)',
};

export function visualPagesOf(pages: readonly PageText[]): VisualPage[] {
  const out: VisualPage[] = [];
  for (const page of pages) {
    const kind = kindOf(page);
    if (kind) out.push({ page: labelOf(page), kind });
  }
  return out;
}

export function joinPages(pages: readonly PageText[], text: string): string {
  if (pages.length <= 1) return text;
  return pages
    .map((page) => {
      const kind = kindOf(page);
      return `<!-- page ${labelOf(page)}${kind ? MARKER_SUFFIX[kind] : ''} -->\n\n${page.markdown}`;
    })
    .join('\n\n');
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_LENGTH = 200;

const WORKER_DIED_PREFIX = /^liteparse worker process died while parsing .*?: /s;

function extractReason(message: string, path: string): string {
  let reason = message.replace(WORKER_DIED_PREFIX, '');
  if (path) reason = reason.split(path).join('');
  return reason.trim();
}

export function mapError(error: unknown, path = ''): DistillError {
  if (error instanceof DistillError) return error;
  if (error instanceof ParseTimeoutError) {
    return new DistillError('timeout', error.message.split(error.source).join('').trim() || 'parse timed out', { cause: error });
  }
  const raw = error instanceof Error ? error.message : String(error);
  const reason = extractReason(raw, path);
  const code = /password|encrypted/i.test(reason) ? 'password_protected' : 'parse_failed';
  return new DistillError(code, reason.slice(0, MAX_MESSAGE_LENGTH), { cause: error });
}

export function parserOptionsFromEnv(env: NodeJS.ProcessEnv): { ocrLanguage: string; tessdataPath?: string } {
  const tessdataPath = env.DISTILL_TESSDATA;
  return {
    ocrLanguage: env.DISTILL_OCR_LANG || 'eng',
    ...(tessdataPath ? { tessdataPath } : {}),
  };
}

export function createParser(opts: { poolSize?: number; timeoutMs?: number } = {}): Parser {
  const poolSize = opts.poolSize ?? Math.min(4, availableParallelism());
  const parseTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const build = (outputFormat: 'markdown' | 'json') =>
    new LiteParse({
      outputFormat,
      imageMode: 'placeholder',
      extractLinks: true,
      keepHeadersFooters: false,
      ocrEnabled: true,
      ...parserOptionsFromEnv(process.env),
      includeComplexity: true,
      quiet: true,
      poolSize,
      parseTimeoutMs,
    });

  const markdownParser = build('markdown');
  let jsonParser: LiteParse | null = null;

  return {
    async toMarkdown(path) {
      try {
        const result = await markdownParser.parse(path);
        return { markdown: joinPages(result.pages, result.text), pages: result.totalPages, visualPages: visualPagesOf(result.pages) };
      } catch (error) {
        throw mapError(error, path);
      }
    },
    async toJson(path) {
      try {
        jsonParser ??= build('json');
        const result = await jsonParser.parse(path);
        return result;
      } catch (error) {
        throw mapError(error, path);
      }
    },
    close() {
      markdownParser.close();
      jsonParser?.close();
    },
  };
}
