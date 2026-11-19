import { describe, expect, it } from 'vitest';
import { cacheDirFromEnv } from '../../src/node/cache-dir';

describe('cacheDirFromEnv', () => {
  it('returns an absolute path', () => {
    expect(cacheDirFromEnv({ DISTILL_CACHE_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('trims whitespace', () => {
    expect(cacheDirFromEnv({ DISTILL_CACHE_DIR: '  /tmp/x ' })).toBe('/tmp/x');
  });

  it('ignores unset, blank and relative values', () => {
    expect(cacheDirFromEnv({})).toBeUndefined();
    expect(cacheDirFromEnv({ DISTILL_CACHE_DIR: '' })).toBeUndefined();
    expect(cacheDirFromEnv({ DISTILL_CACHE_DIR: 'relative/dir' })).toBeUndefined();
  });
});
