import { availableParallelism } from 'node:os';
import { LiteParse, ParseTimeoutError } from '@llamaindex/liteparse';
import { DistillError } from './errors';

export interface Parser {
  toMarkdown(path: string): Promise<{ markdown: string; pages: number }>;
  toJson(path: string): Promise<unknown>;
  close(): void;
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
        return { markdown: result.text, pages: result.totalPages };
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
