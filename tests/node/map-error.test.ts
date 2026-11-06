import { describe, expect, it } from 'vitest';
import { ParseTimeoutError } from '@llamaindex/liteparse';
import { mapError } from '../../src/node/parse';

const path = '/tmp/distill-x/encrypted-backup.pdf';

function poolError(reason: string): Error {
  return new Error(`liteparse worker process died while parsing ${path}: ${reason}`);
}

describe('mapError', () => {
  it('ignores the path and strips the pool prefix', () => {
    const mapped = mapError(poolError('invalid xref table'), path);
    expect(mapped.code).toBe('parse_failed');
    expect(mapped.message).toBe('invalid xref table');
    expect(mapped.message).not.toContain('encrypted-backup');
    expect(mapped.message).not.toContain('worker process died');
  });

  it('classifies password reasons', () => {
    expect(mapError(poolError('password required'), path).code).toBe('password_protected');
  });

  it('cuts the reason to 200 characters', () => {
    expect(mapError(poolError('x'.repeat(500)), path).message).toHaveLength(200);
  });

  it('maps ParseTimeoutError to timeout and keeps the cause', () => {
    const cause = new ParseTimeoutError('timed out', path, 1);
    const mapped = mapError(cause, path);
    expect(mapped.code).toBe('timeout');
    expect(mapped.cause).toBe(cause);
  });
});
