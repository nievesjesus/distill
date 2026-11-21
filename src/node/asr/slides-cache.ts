import { join } from 'node:path';
import type { Slide } from '../../core/transcript';
import { readJsonFile, sha256Of, writePrivateJson } from './cache';

export const FRAMES_VERSION = 'v1';

function slidesPath(cacheDir: string, sha: string): string {
  return join(cacheDir, 'transcripts', `${sha}-slides-${FRAMES_VERSION}.json`);
}

function validSlides(value: unknown): value is Slide[] {
  return (
    Array.isArray(value) &&
    value.every((slide) => slide && typeof slide.at === 'number' && Array.isArray(slide.lines) && slide.lines.every((line: unknown) => typeof line === 'string'))
  );
}

export async function cachedSlides(input: string, cacheDir: string): Promise<Slide[] | undefined> {
  const parsed = (await readJsonFile(slidesPath(cacheDir, await sha256Of(input)))) as { slides?: unknown } | undefined;
  return parsed && validSlides(parsed.slides) ? parsed.slides : undefined;
}

export async function storeSlides(input: string, cacheDir: string, slides: Slide[]): Promise<void> {
  await writePrivateJson(slidesPath(cacheDir, await sha256Of(input)), { slides });
}
