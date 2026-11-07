import * as fs from 'node:fs';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAtomic } from '../../src/hooks/atomic';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-atomic-'));
  vi.mocked(fs.writeFileSync).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomic', () => {
  it('replaces the content', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');
    writeAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')('creates the temp file with the target mode, never wider', () => {
    const file = join(dir, 'secret.json');
    writeFileSync(file, 'old');
    chmodSync(file, 0o600);
    writeAtomic(file, 'new');

    const tmpCall = vi.mocked(fs.writeFileSync).mock.calls.find(([path]) => String(path).endsWith('.tmp'));
    expect(tmpCall?.[2]).toMatchObject({ mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
