import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAsrStatus } from '../../../src/node/asr-install';
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

const smallInstalled = enabled && getAsrStatus({ cacheDir: process.env.DISTILL_CACHE_DIR!, model: 'whisper-small' }).installed;
const sample = (name: string) => process.env[name] && existsSync(process.env[name]!) ? process.env[name]! : undefined;

describe.skipIf(!smallInstalled)('whisper-small (DISTILL_ASR_E2E=1)', () => {
  const cacheDir = process.env.DISTILL_CACHE_DIR!;
  const env = { ...process.env, DISTILL_ASR_MODEL: 'whisper-small' };

  it.skipIf(!sample('DISTILL_ASR_E2E_JA'))('detects Japanese', async () => {
    const result = await transcribe(sample('DISTILL_ASR_E2E_JA')!, { cacheDir, env });
    expect(result.model).toBe('whisper-small');
    expect(result.lang).toBe('ja');
    expect(result.segments.length).toBeGreaterThan(0);
  }, 300_000);

  it.skipIf(!sample('DISTILL_ASR_E2E_ZH'))('detects Chinese', async () => {
    const result = await transcribe(sample('DISTILL_ASR_E2E_ZH')!, { cacheDir, env });
    expect(result.lang).toBe('zh');
  }, 300_000);

  it.skipIf(!sample('DISTILL_ASR_E2E_LONG'))('fixes the majority language after five segments', async () => {
    const result = await transcribe(sample('DISTILL_ASR_E2E_LONG')!, { cacheDir, env });
    expect(result.segments.length).toBeGreaterThan(5);
    expect(result.lang).toBe(process.env.DISTILL_ASR_E2E_LONG_LANG ?? 'es');
  }, 900_000);
});
