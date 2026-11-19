import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transcribe } from '../../../src/node/asr/transcribe';

const enabled = process.env.DISTILL_ASR_E2E === '1' && process.platform === 'darwin' && !!process.env.DISTILL_CACHE_DIR;

describe.skipIf(!enabled)('real model (DISTILL_ASR_E2E=1)', () => {
  it('transcribes a short spoken WAV', async () => {
    const worker = join(process.cwd(), 'dist', 'asr-worker.js');
    expect(existsSync(worker)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'asr-e2e-'));
    try {
      const wav = join(dir, 'x.wav');
      execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', `The quarterly revenue was four point two million dollars, report number ${Date.now() % 1000}.`]);
      const first = await transcribe(wav, { cacheDir: process.env.DISTILL_CACHE_DIR!, env: process.env });
      expect(first.cached).toBe(false);
      expect(first.duration).toBeGreaterThan(2);
      const text = first.segments.map((s) => s.text).join(' ').toLowerCase();
      expect(text).toMatch(/revenue/);
      const second = await transcribe(wav, { cacheDir: process.env.DISTILL_CACHE_DIR!, env: process.env });
      expect(second.cached).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
