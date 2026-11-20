import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

describe('Dockerfile', () => {
  it('ships both on-demand runtimes', () => {
    expect(dockerfile).toContain('COPY lingua-runtime/package.json lingua-runtime/package-lock.json ./lingua-runtime/');
    expect(dockerfile).toContain('COPY asr-runtime/package.json asr-runtime/package-lock.json ./asr-runtime/');
  });

  it('installs ffmpeg for audio and video', () => {
    expect(dockerfile).toMatch(/apt-get install[\s\S]*\n\s+ffmpeg\b/);
  });
});
