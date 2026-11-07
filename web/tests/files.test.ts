import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBoosterId } from '@core/types';
import { DEFAULT_SETTINGS } from '../src/state/settings';
import type { Settings } from '../src/state/settings';
import { useFiles } from '../src/state/files';

const distillMock = vi.hoisted(() => vi.fn());
const forgetRawMock = vi.hoisted(() => vi.fn());

vi.mock('../src/worker/client', () => ({ distill: distillMock, forgetRaw: forgetRawMock }));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function health(maxBytes = 1000) {
  return Response.json({ version: '1', liteparseVersion: '1', libreoffice: false, maxBytes, lingua: { installed: false } });
}

function parsed(name: string) {
  return Response.json({ id: `srv-${name}`, name, kind: 'PDF', pages: 1, markdown: `# ${name}\n\n\n\nbody`, ms: 1 });
}

function fileOf(name: string, size = 10): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function parseCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/parse').length;
}

const settingsWith = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

beforeEach(() => {
  distillMock.mockReset();
  forgetRawMock.mockReset();
  distillMock.mockImplementation(async (raw: string, active: LocalBoosterId[]) => {
    const out = raw.slice(0, raw.length - active.length);
    return { out, rawTokens: raw.length, outTokens: out.length };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useFiles', () => {
  it('rejects files over max size client-side without uploading', async () => {
    const fetchMock = vi.fn(async () => health(50));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('big.pdf', 100)]));
    await waitFor(() => expect(result.current.files[0]?.status).toBe('error'));
    expect(result.current.files[0]?.error?.code).toBe('too_large');
    expect(parseCalls(fetchMock)).toBe(0);
  });

  it('marks unknown extensions unsupported_type client-side', async () => {
    const fetchMock = vi.fn(async () => health());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('notes.xyz')]));
    await waitFor(() => expect(result.current.files[0]?.status).toBe('error'));
    expect(result.current.files[0]?.error?.code).toBe('unsupported_type');
    expect(result.current.files[0]?.kind).toBeNull();
    expect(parseCalls(fetchMock)).toBe(0);
  });

  it('keeps two rows for the same file dropped twice', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/health' ? health() : parsed('a.pdf'))));
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    const file = fileOf('a.pdf');
    act(() => result.current.add([file]));
    act(() => result.current.add([file]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    const ids = result.current.files.map((f) => f.localId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('limits concurrent uploads to 3', async () => {
    let inflight = 0;
    let peak = 0;
    const gates: Array<Deferred<Response>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/health') return health();
        inflight += 1;
        peak = Math.max(peak, inflight);
        const gate = deferred<Response>();
        gates.push(gate);
        const response = await gate.promise;
        inflight -= 1;
        return response;
      }),
    );
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add(Array.from({ length: 6 }, (_, i) => fileOf(`f${i}.pdf`))));
    await waitFor(() => expect(gates).toHaveLength(3));
    expect(result.current.files.filter((f) => f.status === 'parsing')).toHaveLength(3);
    for (let released = 0; released < 6; released += 1) {
      await waitFor(() => expect(gates.length).toBeGreaterThan(released));
      await act(async () => gates[released]?.resolve(parsed(`f${released}.pdf`)));
      expect(result.current.files.filter((f) => f.status === 'parsing').length).toBeLessThanOrEqual(3);
    }
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    expect(peak).toBe(3);
  });

  it('one failing file does not stop the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/health') return health();
        const name = ((init?.body as FormData).get('file') as File).name;
        if (name === 'bad.pdf') return Response.json({ code: 'timeout', message: 'slow' }, { status: 504 });
        return parsed(name);
      }),
    );
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('bad.pdf'), fileOf('c.pdf'), fileOf('d.pdf'), fileOf('e.pdf')]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done' || f.status === 'error')).toBe(true));
    const bad = result.current.files.find((f) => f.name === 'bad.pdf');
    expect(bad?.status).toBe('error');
    expect(bad?.error?.code).toBe('timeout');
    expect(result.current.files.filter((f) => f.status === 'done')).toHaveLength(4);
  });

  it('toggling a booster recomputes out without refetching', async () => {
    const fetchMock = vi.fn(async (url: string) => (url === '/api/health' ? health() : parsed('a.pdf')));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ settings }) => useFiles(settings), {
      initialProps: { settings: DEFAULT_SETTINGS },
    });
    act(() => result.current.add([fileOf('a.pdf')]));
    await waitFor(() => expect(result.current.files[0]?.outTokens).toBeDefined());
    const raw = result.current.files[0]?.raw ?? '';
    expect(result.current.files[0]?.out).toBe(raw.slice(0, raw.length - 4));
    rerender({ settings: settingsWith({ active: ['dedupe', 'media'] }) });
    await waitFor(() => expect(result.current.files[0]?.out).toBe(raw.slice(0, raw.length - 2)));
    expect(parseCalls(fetchMock)).toBe(1);
  });

  it('ignores a stale worker reply after a quick double toggle', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/health' ? health() : parsed('a.pdf'))));
    const { result, rerender } = renderHook(({ settings }) => useFiles(settings), {
      initialProps: { settings: DEFAULT_SETTINGS },
    });
    act(() => result.current.add([fileOf('a.pdf')]));
    await waitFor(() => expect(result.current.files[0]?.outTokens).toBeDefined());

    const gates: Array<Deferred<{ out: string; rawTokens: number; outTokens: number }>> = [];
    distillMock.mockImplementation(() => {
      const gate = deferred<{ out: string; rawTokens: number; outTokens: number }>();
      gates.push(gate);
      return gate.promise;
    });
    rerender({ settings: settingsWith({ active: ['dedupe'] }) });
    await waitFor(() => expect(gates).toHaveLength(1));
    rerender({ settings: settingsWith({ active: ['dedupe', 'ws'] }) });
    await waitFor(() => expect(gates).toHaveLength(2));

    await act(async () => gates[1]?.resolve({ out: 'second', rawTokens: 10, outTokens: 6 }));
    await act(async () => gates[0]?.resolve({ out: 'first', rawTokens: 10, outTokens: 9 }));
    expect(result.current.files[0]?.out).toBe('second');
    expect(result.current.files[0]?.outTokens).toBe(6);
  });

  it('shows equal raw and out counts when optimize is off, without asking the worker for out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/health' ? health() : parsed('a.pdf'))));
    const { result } = renderHook(() => useFiles(settingsWith({ optimize: false })));
    act(() => result.current.add([fileOf('a.pdf')]));
    await waitFor(() => expect(result.current.files[0]?.outTokens).toBeDefined());
    const row = result.current.files[0];
    expect(row?.out).toBe(row?.raw);
    expect(row?.outTokens).toBe(row?.rawTokens);
    expect(distillMock.mock.calls.every(([, active]) => (active as LocalBoosterId[]).length === 0)).toBe(true);
  });

  it('keeps files queued and does not upload until health resolves', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(async (url: string) => (url === '/api/health' ? gate.promise : parsed('a.pdf')));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf')]));
    expect(result.current.files[0]?.status).toBe('queued');
    expect(parseCalls(fetchMock)).toBe(0);
    await act(async () => gate.resolve(health()));
    await waitFor(() => expect(result.current.files[0]?.status).toBe('done'));
    expect(parseCalls(fetchMock)).toBe(1);
  });

  it('reports an app-level error and keeps files queued when health fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf')]));
    await waitFor(() => expect(result.current.healthError?.code).toBe('parse_failed'));
    expect(result.current.files[0]?.status).toBe('queued');
  });
});

describe('useFiles remove and clear', () => {
  function recordingFetch(options: { holdParse?: boolean } = {}) {
    const calls: Array<{ url: string; method: string; signal?: AbortSignal | null }> = [];
    const gates: Array<Deferred<Response>> = [];
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', signal: init?.signal });
      if (url === '/api/health') return health();
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const name = ((init?.body as FormData).get('file') as File).name;
      if (options.holdParse) {
        const gate = deferred<Response>();
        gates.push(gate);
        return gate.promise;
      }
      return parsed(name);
    });
    vi.stubGlobal('fetch', mock);
    return { calls, gates };
  }

  it('removes a finished row and deletes it on the server', async () => {
    const { calls } = recordingFetch();
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('b.pdf')]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    const [first, second] = result.current.files;
    act(() => result.current.remove(first.localId));
    expect(result.current.files.map((f) => f.localId)).toEqual([second.localId]);
    expect(calls).toContainEqual(expect.objectContaining({ url: '/api/files/srv-a.pdf', method: 'DELETE' }));
  });

  it('aborts an in-flight upload when its row is removed', async () => {
    const { calls, gates } = recordingFetch({ holdParse: true });
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf')]));
    await waitFor(() => expect(gates).toHaveLength(1));
    const upload = calls.find((call) => call.url === '/api/parse');
    expect(upload?.signal?.aborted).toBe(false);
    act(() => result.current.remove(result.current.files[0].localId));
    expect(upload?.signal?.aborted).toBe(true);
    expect(result.current.files).toHaveLength(0);
  });

  it('never uploads a queued row that was removed', async () => {
    const { gates } = recordingFetch({ holdParse: true });
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add(Array.from({ length: 5 }, (_, i) => fileOf(`f${i}.pdf`))));
    await waitFor(() => expect(gates).toHaveLength(3));
    const queued = result.current.files.filter((f) => f.status === 'queued');
    expect(queued).toHaveLength(2);
    act(() => result.current.remove(queued[0].localId));
    act(() => gates[0].resolve(parsed('f0.pdf')));
    await waitFor(() => expect(gates).toHaveLength(4));
    act(() => {
      gates[1].resolve(parsed('f1.pdf'));
      gates[2].resolve(parsed('f2.pdf'));
      gates[3].resolve(parsed('f4.pdf'));
    });
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    expect(result.current.files.map((f) => f.name)).toEqual(['f0.pdf', 'f1.pdf', 'f2.pdf', 'f4.pdf']);
    expect(gates).toHaveLength(4);
  });

  it('ignores a late worker reply for a removed row', async () => {
    recordingFetch();
    const slow = deferred<{ out: string; rawTokens: number; outTokens: number }>();
    distillMock.mockImplementation(() => slow.promise);
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('b.pdf')]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    act(() => result.current.remove(result.current.files[0].localId));
    await act(async () => {
      slow.resolve({ out: 'x', rawTokens: 5, outTokens: 1 });
    });
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].name).toBe('b.pdf');
  });

  it('clears everything, aborts uploads and deletes on the server', async () => {
    const { calls, gates } = recordingFetch({ holdParse: true });
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('b.pdf'), fileOf('c.pdf'), fileOf('d.pdf')]));
    await waitFor(() => expect(gates).toHaveLength(3));
    act(() => result.current.clear());
    expect(result.current.files).toEqual([]);
    const uploads = calls.filter((call) => call.url === '/api/parse');
    expect(uploads.every((call) => call.signal?.aborted)).toBe(true);
    expect(calls).not.toContainEqual(expect.objectContaining({ url: '/api/files', method: 'DELETE' }));
    await act(async () => {
      gates.forEach((gate) => gate.resolve(parsed('late.pdf')));
    });
    expect(result.current.files).toEqual([]);
    expect(gates).toHaveLength(3);
  });

  it('clear deletes only the ids this client knows, one by one', async () => {
    const { calls } = recordingFetch();
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('b.pdf')]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    act(() => result.current.clear());
    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url).sort();
    expect(deletes).toEqual(['/api/files/srv-a.pdf', '/api/files/srv-b.pdf']);
  });

  it('forgets the raw text in the worker client on remove and clear', async () => {
    recordingFetch();
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('b.pdf')]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    act(() => result.current.remove(result.current.files[0].localId));
    expect(forgetRawMock).toHaveBeenCalledWith('# a.pdf\n\n\n\nbody');
    act(() => result.current.clear());
    expect(forgetRawMock).toHaveBeenCalledWith('# b.pdf\n\n\n\nbody');
  });

  it('survives a failing server delete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/health') return health();
        if (init?.method === 'DELETE') throw new TypeError('network down');
        return parsed('a.pdf');
      }),
    );
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf')]));
    await waitFor(() => expect(result.current.files[0]?.status).toBe('done'));
    act(() => result.current.remove(result.current.files[0].localId));
    act(() => result.current.clear());
    expect(result.current.files).toEqual([]);
  });

  it('marks files as exported', async () => {
    recordingFetch();
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf'), fileOf('b.pdf')]));
    await waitFor(() => expect(result.current.files.every((f) => f.status === 'done')).toBe(true));
    const [first, second] = result.current.files;
    act(() => result.current.markExported([first.localId]));
    expect(result.current.files.find((f) => f.localId === first.localId)?.exported).toBe(true);
    expect(result.current.files.find((f) => f.localId === second.localId)?.exported).toBeUndefined();
  });

  it('keeps retrying /api/health with backoff until it answers, then starts queued rows', async () => {
    vi.useFakeTimers();
    let healthCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/health') {
        healthCalls += 1;
        if (healthCalls < 4) throw new TypeError('not up yet');
        return health();
      }
      return parsed('a.pdf');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    act(() => result.current.add([fileOf('a.pdf')]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(healthCalls).toBe(1);
    expect(result.current.healthError).not.toBeNull();
    expect(result.current.files[0].status).toBe('queued');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(healthCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(healthCalls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(healthCalls).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(healthCalls).toBe(4);
    expect(result.current.healthError).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.files[0].status).toBe('done');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(healthCalls).toBe(4);
  });

  it('caps the health retry delay at 10 seconds', async () => {
    vi.useFakeTimers();
    let healthCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        healthCalls += 1;
        throw new TypeError('down');
      }),
    );
    renderHook(() => useFiles(DEFAULT_SETTINGS));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
    });
    expect(healthCalls).toBe(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(healthCalls).toBe(6);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(healthCalls).toBe(7);
  });

  it('stops retrying health after unmount', async () => {
    vi.useFakeTimers();
    let healthCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        healthCalls += 1;
        throw new TypeError('down');
      }),
    );
    const { unmount } = renderHook(() => useFiles(DEFAULT_SETTINGS));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(healthCalls).toBe(1);
  });
});
