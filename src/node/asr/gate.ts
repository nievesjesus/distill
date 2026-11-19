import { resolveFfmpeg as defaultResolveFfmpeg } from '../asr-install';
import { cachedTranscript, knownDuration } from './transcribe';

export const MEDIA_AUTO_SECONDS = 600;

export type MediaPlan = 'convert' | { defer: string };

export interface MediaGateOptions {
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  cached?: typeof cachedTranscript;
  duration?: typeof knownDuration;
  resolveFfmpeg?: (env: NodeJS.ProcessEnv) => string | null;
  maxSeconds?: number;
}

export function createMediaGate(options: MediaGateOptions): (path: string) => Promise<MediaPlan> {
  const cached = options.cached ?? cachedTranscript;
  const duration = options.duration ?? knownDuration;
  const findFfmpeg = options.resolveFfmpeg ?? defaultResolveFfmpeg;
  const limit = options.maxSeconds ?? MEDIA_AUTO_SECONDS;
  return async (path) => {
    if ((await cached(path, options.cacheDir).catch(() => undefined)) !== undefined) return 'convert';
    const seconds = await duration(path, findFfmpeg(options.env)).catch(() => undefined);
    if (seconds !== undefined && seconds <= limit) return 'convert';
    const length = seconds === undefined ? 'of unknown length' : `about ${Math.max(1, Math.round(seconds / 60))} min`;
    return {
      defer: `distill can transcribe ${path} locally, but this recording is ${length} and transcribing takes longer than a Read can wait, so it was not converted here. Use the MCP tool distill_file with this path, or run \`distill-llm convert --stdout "${path}"\` in the shell; the transcript is cached, so reading the file again afterwards is instant.`,
    };
  };
}
