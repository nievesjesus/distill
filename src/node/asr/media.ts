import { basename } from 'node:path';
import { detectKind } from '../../core/kind';
import { countTokens } from '../../core/tokens';
import { type Slide, detectLang, formatTranscript, renderSrt, transcriptHeader } from '../../core/transcript';
import { resolveFfmpeg as defaultResolveFfmpeg } from '../asr-install';
import { DistillError } from '../errors';
import type { Parser } from '../parse';
import { AsrError } from './errors';
import { collectSlides as defaultCollectSlides } from './frames';
import { transcribe as defaultTranscribe } from './transcribe';

export interface MediaDeps {
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
  transcribe?: typeof defaultTranscribe;
  collectSlides?: typeof defaultCollectSlides;
  resolveFfmpeg?: (env: NodeJS.ProcessEnv) => string | null;
}

const NO_SPEECH = '_No speech detected._';

export function withMedia(parser: Parser, deps: MediaDeps): Parser {
  const env = deps.env ?? process.env;
  const transcribe = deps.transcribe ?? defaultTranscribe;
  const collectSlides = deps.collectSlides ?? defaultCollectSlides;
  const findFfmpeg = deps.resolveFfmpeg ?? defaultResolveFfmpeg;

  async function build(path: string, opts: Parameters<Parser['toMarkdown']>[1]) {
    const kind = detectKind(path);
    let result: Awaited<ReturnType<typeof transcribe>>;
    try {
      result = await transcribe(path, { cacheDir: deps.cacheDir, env, ...(opts?.signal ? { signal: opts.signal } : {}) });
    } catch (error) {
      if (error instanceof AsrError) throw new DistillError(error.code, error.message, { cause: error });
      throw error;
    }
    const lang = detectLang(result.segments);
    let slides: Slide[] = [];
    if (kind === 'VIDEO' && (opts?.frames ?? 'ocr') === 'ocr') {
      const ffmpeg = findFfmpeg(env);
      if (ffmpeg !== null) {
        slides = await collectSlides(path, {
          ffmpeg,
          duration: result.duration,
          ocr: async (png) => (await parser.toMarkdown(png)).markdown,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        }).catch((error) => {
          if (error instanceof AsrError) throw new DistillError(error.code, error.message, { cause: error });
          throw error;
        });
      }
    }
    const body = formatTranscript(result.segments, { timestamps: opts?.timestamps ?? 'coarse', ...(lang ? { lang } : {}), slides });
    const header = transcriptHeader({ name: basename(path), duration: result.duration, ...(lang ? { lang } : {}) });
    const markdown = `${header}\n\n${body === '' ? NO_SPEECH : body}`;
    return { markdown, segments: result.segments, rawTokens: result.segments.length === 0 ? 0 : countTokens(renderSrt(result.segments)) };
  }

  const isMedia = (path: string) => {
    const kind = detectKind(path);
    return kind === 'AUDIO' || kind === 'VIDEO';
  };

  return {
    async toMarkdown(path, opts) {
      if (!isMedia(path)) return parser.toMarkdown(path, opts);
      const { markdown, rawTokens } = await build(path, opts);
      return { markdown, pages: 1, engine: 'builtin', rawTokens };
    },
    async toJson(path) {
      if (!isMedia(path)) return parser.toJson(path);
      const { markdown, segments } = await build(path, undefined);
      return { format: 'transcript', segments, markdown };
    },
    renderPage: (path, page, opts) => parser.renderPage(path, page, opts),
    close: () => parser.close(),
  };
}
