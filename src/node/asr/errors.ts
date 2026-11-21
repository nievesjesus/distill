export type AsrErrorCode = 'asr_unavailable' | 'ffmpeg_missing' | 'no_audio' | 'asr_failed' | 'aborted' | 'timeout';

export class AsrError extends Error {
  constructor(
    readonly code: AsrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AsrError';
  }
}

export const FFMPEG_MISSING_MESSAGE =
  'ffmpeg is required to read this audio or video format but was not found. Install it (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg; Windows: winget install Gyan.FFmpeg) or set DISTILL_FFMPEG to its absolute path.';

export const ASR_UNAVAILABLE_MESSAGE = 'Speech recognition is not installed. Run `distill-llm asr install` to download it (about 700 MB, one time).';

export function asrUnavailableMessage(model: string, bytes: number): string {
  const megabytes = Math.round(bytes / 1_000_000);
  return `Speech recognition is not installed for the ${model} model. Run \`distill-llm asr install --model ${model}\` to download it (about ${megabytes} MB, one time).`;
}
