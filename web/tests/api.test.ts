import { afterEach, describe, expect, it, vi } from 'vitest';
import { compress, getHealth, getJson, parseFile } from '../src/api';

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('returns parsed JSON on success', async () => {
    stubFetch(async () => Response.json({ version: '1', maxBytes: 5 }));
    await expect(getHealth()).resolves.toMatchObject({ maxBytes: 5 });
  });

  it('throws the ApiError body of a non-OK response', async () => {
    stubFetch(async () => Response.json({ code: 'too_large', message: 'File too large' }, { status: 413 }));
    await expect(parseFile(new File(['x'], 'a.pdf'))).rejects.toEqual({ code: 'too_large', message: 'File too large' });
  });

  it('maps a non-JSON error body to parse_failed with the status', async () => {
    stubFetch(async () => new Response('<html>oops</html>', { status: 502 }));
    await expect(getJson('abc')).rejects.toEqual({ code: 'parse_failed', message: 'Unexpected response (status 502)' });
  });

  it('maps a network failure to parse_failed', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(getHealth()).rejects.toEqual({ code: 'parse_failed', message: 'Cannot reach distill. Is it still running?' });
  });

  it('does not swallow an abort', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    stubFetch(async () => {
      throw abort;
    });
    await expect(parseFile(new File(['x'], 'a.pdf'), new AbortController().signal)).rejects.toBe(abort);
  });

  it('posts compress and returns the text', async () => {
    let body = '';
    stubFetch(async (_url, init) => {
      body = String(init?.body);
      return Response.json({ text: 'short' });
    });
    await expect(compress('long text', 0.5, 'tinybert')).resolves.toBe('short');
    expect(JSON.parse(body)).toEqual({ text: 'long text', rate: 0.5, model: 'tinybert' });
  });
});
