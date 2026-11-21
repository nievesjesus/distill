import { detectKind } from '../../core/kind';
import { resolveFfmpeg as defaultResolveFfmpeg } from '../asr-install';
import { FFMPEG_MISSING_MESSAGE } from './errors';
import { cachedSlides } from './slides-cache';
import { ASR_MODELS } from './models';
import { cachedTranscript, knownDuration, resolveAsrSelection } from './transcribe';

export const MEDIA_AUTO_SECONDS = ASR_MODELS.parakeet.autoSeconds;

export type MediaPlan = 'convert' | { defer: string };

export interface MediaGateOptions {
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  cached?: typeof cachedTranscript;
  slides?: typeof cachedSlides;
  duration?: typeof knownDuration;
  resolveFfmpeg?: (env: NodeJS.ProcessEnv) => string | null;
  maxSeconds?: number;
}

export function createMediaGate(options: MediaGateOptions): (path: string) => Promise<MediaPlan> {
  const cached = options.cached ?? cachedTranscript;
  const slidesCached = options.slides ?? cachedSlides;
  const duration = options.duration ?? knownDuration;
  const findFfmpeg = options.resolveFfmpeg ?? defaultResolveFfmpeg;
  const activeLimit = (): number => {
    try {
      return resolveAsrSelection({ cacheDir: options.cacheDir, env: options.env }).spec.autoSeconds;
    } catch {
      return MEDIA_AUTO_SECONDS;
    }
  };
  return async (path) => {
    const limit = options.maxSeconds ?? activeLimit();
    const ffmpeg = findFfmpeg(options.env);
    const needsSlides = ffmpeg !== null && detectKind(path) === 'VIDEO';
    const transcribed = (await cached(path, options.cacheDir, { env: options.env }).catch(() => undefined)) !== undefined;
    if (transcribed && (!needsSlides || (await slidesCached(path, options.cacheDir).catch(() => undefined)) !== undefined)) return 'convert';
    const seconds = await duration(path, ffmpeg).catch(() => undefined);
    if (seconds !== undefined && seconds <= limit) return 'convert';
    if (seconds === undefined && ffmpeg === null) return { defer: FFMPEG_MISSING_MESSAGE };
    const length = seconds === undefined ? 'of unknown length' : `about ${Math.max(1, Math.round(seconds / 60))} min`;
    return {
      defer: `distill can transcribe this recording locally, but it is ${length} and transcribing takes longer than a Read can wait, so it was not converted here. Use the MCP tool distill_file with this path, or run \`distill-llm convert --stdout ${shellQuote(path)}\` in the shell with a 600000 ms timeout; the transcript is cached, so reading the file again afterwards is instant.`,
    };
  };
}

function shellQuote(path: string): string {
  if (/[\u0000-\u001f\u007f]/.test(path)) return "'<file>'";
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
