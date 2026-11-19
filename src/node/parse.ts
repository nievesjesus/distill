import { availableParallelism } from 'node:os';
import { LiteParse, ParseTimeoutError } from '@llamaindex/liteparse';
import type { VisualKind, VisualPage } from '../core/types';
import { DistillError } from './errors';

export interface Parser {
  toMarkdown(path: string, opts?: { mode?: 'clean' | 'full' }): Promise<{ markdown: string; pages: number; engine?: 'liteparse' | 'builtin'; visualPages?: VisualPage[]; rawTokens?: number }>;
  toJson(path: string): Promise<unknown>;
  renderPage(path: string, page: number, opts: { dpi: number }): Promise<RenderedPng>;
  close(): void;
}

export interface RenderedPng {
  png: Buffer;
  width: number;
  height: number;
}

export interface PageComplexity {
  textLength?: number;
  fullPageImage: boolean;
  largestImageCoverage: number;
  uncoveredVectorArea?: number;
  layout?: { figureCount?: number; figureCoverage?: number; ruledTableCount?: number };
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
const FIGURE_LAYOUT_COVERAGE = 0.03;

export function classifyPage(complexity: PageComplexity | undefined, textLength: number): VisualKind | null {
  if (!complexity) return null;
  if (complexity.fullPageImage) return 'scan';
  if (complexity.largestImageCoverage >= FIGURE_IMAGE_COVERAGE) return 'figure';
  if ((complexity.uncoveredVectorArea ?? 0) >= FIGURE_VECTOR_AREA) return 'figure';
  const figureCount = complexity.layout?.figureCount ?? 0;
  if (textLength < FIGURE_SPARSE_TEXT && figureCount > 0) return 'figure';
  if (
    figureCount > 0 &&
    (complexity.layout?.ruledTableCount ?? 0) === 0 &&
    (complexity.layout?.figureCoverage ?? 0) >= FIGURE_LAYOUT_COVERAGE
  )
    return 'figure';
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
    if (!kind) continue;
    const label = labelOf(page);
    out.push({ page: page.pageNum, ...(label !== String(page.pageNum) ? { label } : {}), kind });
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
  const renderers = new Map<number, LiteParse>();
  const rendererFor = (dpi: number): LiteParse => {
    let renderer = renderers.get(dpi);
    if (!renderer) {
      renderer = new LiteParse({ dpi, ocrEnabled: false, quiet: true, poolSize: 1, parseTimeoutMs });
      renderers.set(dpi, renderer);
    }
    return renderer;
  };

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
    async renderPage(path, page, opts) {
      try {
        const [shot] = await rendererFor(opts.dpi).screenshot(path, [page]);
        if (!shot) throw new DistillError('parse_failed', `Page ${page} could not be rendered`);
        return { png: shot.imageBuffer, width: shot.width, height: shot.height };
      } catch (error) {
        const mapped = mapError(error, path);
        if (/out of range/i.test(mapped.message)) throw new DistillError('bad_request', mapped.message, { cause: error });
        throw mapped;
      }
    },
    close() {
      markdownParser.close();
      jsonParser?.close();
      for (const renderer of renderers.values()) renderer.close();
    },
  };
}
