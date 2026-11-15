import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { readZip, zipText } from '../../../src/node/office/zip';

const enc = (s: string) => new TextEncoder().encode(s);

describe('readZip', () => {
  it('round-trips entries', () => {
    const bytes = zipSync({ 'a.txt': enc('hello'), 'dir/b.xml': enc('<x/>') });
    const entries = readZip(bytes);
    expect(entries.size).toBe(2);
    expect(zipText(entries, 'a.txt')).toBe('hello');
    expect(zipText(entries, 'dir/b.xml')).toBe('<x/>');
    expect(zipText(entries, 'missing')).toBeNull();
  });

  it('rejects too many entries', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5001; i++) files[`f${i}`] = new Uint8Array(0);
    expect(() => readZip(zipSync(files))).toThrowError(
      expect.objectContaining({ code: 'parse_failed', message: 'Document archive is too large to read safely' }),
    );
  });

  it('rejects an entry declaring 65 MiB', () => {
    const bytes = zipSync({ 'big.bin': new Uint8Array(65 * 1024 * 1024) }, { level: 9 });
    expect(bytes.length).toBeLessThan(200_000);
    expect(() => readZip(bytes)).toThrowError(
      expect.objectContaining({ code: 'parse_failed', message: 'Document archive is too large to read safely' }),
    );
  });

  it('rejects total uncompressed size over 256 MiB', () => {
    const chunk = new Uint8Array(60 * 1024 * 1024);
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) files[`c${i}`] = chunk;
    expect(() => readZip(zipSync(files, { level: 9 }))).toThrowError(
      expect.objectContaining({ code: 'parse_failed', message: 'Document archive is too large to read safely' }),
    );
  });

  it('turns garbage into parse_failed', () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4, 5]))).toThrowError(
      expect.objectContaining({ code: 'parse_failed', message: 'Could not read the document archive' }),
    );
  });
});
