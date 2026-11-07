import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, ErrorCode, FileKind, Health } from '@core/types';
import { detectKind } from '@core/kind';
import { compress, deleteFile, getHealth, parseFile } from '../api';
import { clearJsonCache, forgetJson } from '../lib/json-cache';
import { ERROR_MESSAGES } from '../strings';
import { distill, forgetRaw } from '../worker/client';
import type { Settings } from './settings';

export const MAX_CONCURRENT_UPLOADS = 3;
export const LINGUA_DEBOUNCE_MS = 400;
export const HEALTH_POLL_MS = 1000;
export const COMPRESS_CACHE_LIMIT = 50;
export const HEALTH_RETRY_BASE_MS = 1000;
export const HEALTH_RETRY_MAX_MS = 10_000;

export interface FileEntry {
  localId: string;
  name: string;
  size: number;
  kind: FileKind | null;
  status: 'queued' | 'parsing' | 'done' | 'error';
  error?: ApiError;
  serverId?: string;
  raw?: string;
  out?: string;
  rawTokens?: number;
  outTokens?: number;
  localOut?: string;
  localOutTokens?: number;
  compressing?: boolean;
  exported?: boolean;
}

export interface FilesApi {
  files: FileEntry[];
  add: (files: File[]) => void;
  remove: (localId: string) => void;
  clear: () => void;
  markExported: (localIds: string[]) => void;
  healthError: ApiError | null;
  health: Health | null;
  linguaFailed: boolean;
  retryLingua: () => void;
}

const KNOWN_CODES = Object.keys(ERROR_MESSAGES) as ErrorCode[];

let nextLocalId = 1;

function toApiError(error: unknown): ApiError {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as Partial<ApiError>;
    if (typeof message === 'string' && KNOWN_CODES.some((known) => known === code)) {
      return { code: code as ErrorCode, message };
    }
  }
  return { code: 'parse_failed', message: error instanceof Error ? error.message : 'parse_failed' };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

interface Compressed {
  text: string;
  tokens: number;
}

function clientError(code: ErrorCode): ApiError {
  return { code, message: code };
}

function ignoreFailure(): void {}

export function useFiles(settings: Settings): FilesApi {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [healthError, setHealthError] = useState<ApiError | null>(null);
  const blobs = useRef(new Map<string, File>());
  const filesRef = useRef<FileEntry[]>([]);
  filesRef.current = files;
  const started = useRef(new Set<string>());
  const uploadControllers = useRef(new Map<string, AbortController>());
  const appliedKey = useRef(new Map<string, string>());
  const requestCounter = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [pollRequested, setPollRequested] = useState(false);
  const [linguaFailed, setLinguaFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const linguaKeys = useRef(new Map<string, string>());
  const linguaTickets = useRef(new Map<string, number>());
  const linguaControllers = useRef(new Map<string, AbortController>());
  const linguaStarted = useRef(new Set<string>());
  const linguaTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const compressCache = useRef(new Map<string, Compressed>());
  const previousParams = useRef('');
  const linguaActive = settings.optimize && settings.lingua.on && health?.lingua?.installed === true;
  const linguaActiveRef = useRef(linguaActive);
  linguaActiveRef.current = linguaActive;

  useEffect(() => {
    mounted.current = true;
    const timers = linguaTimers.current;
    const controllers = linguaControllers.current;
    const uploads = uploadControllers.current;
    return () => {
      mounted.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const controller of uploads.values()) controller.abort();
      uploads.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (failures: number) => {
      getHealth().then(
        (loaded) => {
          if (cancelled) return;
          setHealthError(null);
          setHealth(loaded);
          setMaxBytes(loaded.maxBytes);
        },
        (error: unknown) => {
          if (cancelled) return;
          setHealthError(toApiError(error));
          const delay = Math.min(HEALTH_RETRY_BASE_MS * 2 ** failures, HEALTH_RETRY_MAX_MS);
          timer = setTimeout(() => attempt(failures + 1), delay);
        },
      );
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const patch = useCallback((localId: string, changes: Partial<FileEntry>) => {
    if (!mounted.current) return;
    setFiles((current) => current.map((entry) => (entry.localId === localId ? { ...entry, ...changes } : entry)));
  }, []);

  const patchLocal = useCallback((localId: string, changes: Pick<FileEntry, 'localOut' | 'localOutTokens' | 'rawTokens'>) => {
    if (!mounted.current) return;
    setFiles((current) =>
      current.map((entry) => {
        if (entry.localId !== localId) return entry;
        const keepCompressed = linguaActiveRef.current && entry.out !== undefined;
        if (keepCompressed) return { ...entry, ...changes };
        return { ...entry, ...changes, out: changes.localOut, outTokens: changes.localOutTokens };
      }),
    );
  }, []);

  const release = useCallback((localId: string, serverId?: string, raw?: string) => {
    blobs.current.delete(localId);
    started.current.delete(localId);
    appliedKey.current.delete(localId);
    requestCounter.current.delete(localId);
    uploadControllers.current.get(localId)?.abort();
    uploadControllers.current.delete(localId);
    linguaKeys.current.delete(localId);
    linguaTickets.current.delete(localId);
    linguaStarted.current.delete(localId);
    linguaControllers.current.get(localId)?.abort();
    linguaControllers.current.delete(localId);
    const pending = linguaTimers.current.get(localId);
    if (pending) clearTimeout(pending);
    linguaTimers.current.delete(localId);
    for (const key of Array.from(compressCache.current.keys())) {
      if (key.startsWith(`${localId}:`)) compressCache.current.delete(key);
    }
    if (serverId !== undefined) forgetJson(serverId);
    if (raw !== undefined) forgetRaw(raw);
  }, []);

  const remove = useCallback(
    (localId: string) => {
      const entry = filesRef.current.find((candidate) => candidate.localId === localId);
      if (!entry) return;
      release(localId, entry.serverId, entry.raw);
      setFiles((current) => current.filter((candidate) => candidate.localId !== localId));
      if (entry.serverId !== undefined) deleteFile(entry.serverId).catch(ignoreFailure);
    },
    [release],
  );

  const clear = useCallback(() => {
    const known = filesRef.current;
    for (const entry of known) release(entry.localId, entry.serverId, entry.raw);
    compressCache.current.clear();
    clearJsonCache();
    setFiles([]);
    setLinguaFailed(false);
    for (const entry of known) {
      if (entry.serverId !== undefined) deleteFile(entry.serverId).catch(ignoreFailure);
    }
  }, [release]);

  const markExported = useCallback((localIds: string[]) => {
    const targets = new Set(localIds);
    setFiles((current) =>
      current.some((entry) => targets.has(entry.localId) && !entry.exported)
        ? current.map((entry) => (targets.has(entry.localId) ? { ...entry, exported: true } : entry))
        : current,
    );
  }, []);

  const add = useCallback((incoming: File[]) => {
    const entries = incoming.map<FileEntry>((file) => {
      const localId = `file-${nextLocalId++}`;
      blobs.current.set(localId, file);
      return { localId, name: file.name, size: file.size, kind: detectKind(file.name), status: 'queued' };
    });
    setFiles((current) => [...current, ...entries]);
  }, []);

  useEffect(() => {
    if (maxBytes === null) return;
    let parsing = files.filter((entry) => entry.status === 'parsing').length;
    for (const entry of files) {
      if (entry.status !== 'queued' || started.current.has(entry.localId)) continue;
      if (entry.kind === null) {
        started.current.add(entry.localId);
        patch(entry.localId, { status: 'error', error: clientError('unsupported_type') });
        continue;
      }
      if (entry.size > maxBytes) {
        started.current.add(entry.localId);
        patch(entry.localId, { status: 'error', error: clientError('too_large') });
        continue;
      }
      if (parsing >= MAX_CONCURRENT_UPLOADS) continue;
      const blob = blobs.current.get(entry.localId);
      if (!blob) continue;
      parsing += 1;
      started.current.add(entry.localId);
      patch(entry.localId, { status: 'parsing' });
      const controller = new AbortController();
      uploadControllers.current.set(entry.localId, controller);
      parseFile(blob, controller.signal).then(
        (response) => {
          blobs.current.delete(entry.localId);
          uploadControllers.current.delete(entry.localId);
          patch(entry.localId, { status: 'done', serverId: response.id, raw: response.markdown });
        },
        (error: unknown) => {
          blobs.current.delete(entry.localId);
          uploadControllers.current.delete(entry.localId);
          if (controller.signal.aborted) return;
          patch(entry.localId, { status: 'error', error: toApiError(error) });
        },
      );
    }
  }, [files, maxBytes, patch]);

  const settingsKey = `${settings.optimize}:${settings.active.join(',')}`;

  useEffect(() => {
    const boosters = settings.optimize ? settings.active : [];
    for (const entry of files) {
      if (entry.status !== 'done' || entry.raw === undefined) continue;
      if (appliedKey.current.get(entry.localId) === settingsKey) continue;
      appliedKey.current.set(entry.localId, settingsKey);
      const raw = entry.raw;

      if (boosters.length === 0 && entry.rawTokens !== undefined) {
        requestCounter.current.set(entry.localId, (requestCounter.current.get(entry.localId) ?? 0) + 1);
        patchLocal(entry.localId, { localOut: raw, localOutTokens: entry.rawTokens, rawTokens: entry.rawTokens });
        continue;
      }

      const ticket = (requestCounter.current.get(entry.localId) ?? 0) + 1;
      requestCounter.current.set(entry.localId, ticket);
      distill(raw, boosters).then(
        (result) => {
          if (requestCounter.current.get(entry.localId) !== ticket) return;
          if (boosters.length === 0) patchLocal(entry.localId, { localOut: raw, localOutTokens: result.rawTokens, rawTokens: result.rawTokens });
          else patchLocal(entry.localId, { localOut: result.out, localOutTokens: result.outTokens, rawTokens: result.rawTokens });
        },
        (error: unknown) => {
          if (requestCounter.current.get(entry.localId) !== ticket) return;
          patch(entry.localId, { status: 'error', error: toApiError(error) });
        },
      );
    }
  }, [files, settings.optimize, settings.active, settingsKey, patch, patchLocal]);

  const { rate, model } = settings.lingua;

  useEffect(() => {
    const params = `${model}:${rate}`;
    const paramsChanged = previousParams.current !== '' && previousParams.current !== params;
    previousParams.current = params;
    if (paramsChanged) setLinguaFailed(false);

    for (const entry of files) {
      if (entry.status !== 'done' || entry.localOut === undefined || entry.localOutTokens === undefined) continue;
      const id = entry.localId;
      const localOut = entry.localOut;
      const localTokens = entry.localOutTokens;

      if (!linguaActive) {
        if (linguaKeys.current.has(id)) {
          linguaKeys.current.delete(id);
          linguaStarted.current.delete(id);
          linguaControllers.current.get(id)?.abort();
          linguaControllers.current.delete(id);
          linguaTickets.current.set(id, (linguaTickets.current.get(id) ?? 0) + 1);
          const pending = linguaTimers.current.get(id);
          if (pending) clearTimeout(pending);
          linguaTimers.current.delete(id);
        }
        if (entry.compressing || entry.out !== localOut) {
          patch(id, { out: localOut, outTokens: localTokens, compressing: false });
        }
        continue;
      }

      const key = `${hashText(localOut)}:${rate}:${model}`;
      if (linguaKeys.current.get(id) === key) continue;
      linguaKeys.current.set(id, key);
      const ticket = (linguaTickets.current.get(id) ?? 0) + 1;
      linguaTickets.current.set(id, ticket);
      linguaControllers.current.get(id)?.abort();
      const controller = new AbortController();
      linguaControllers.current.set(id, controller);
      const pending = linguaTimers.current.get(id);
      if (pending) clearTimeout(pending);
      linguaTimers.current.delete(id);

      const cacheKey = `${id}:${key}`;
      const cached = compressCache.current.get(cacheKey);
      if (cached) {
        compressCache.current.delete(cacheKey);
        compressCache.current.set(cacheKey, cached);
        patch(id, { out: cached.text, outTokens: cached.tokens, compressing: false });
        continue;
      }

      patch(id, { compressing: true });
      const isStale = () => linguaTickets.current.get(id) !== ticket;

      const run = () => {
        linguaTimers.current.delete(id);
        const state = health?.lingua?.state;
        if (state === 'idle' || state === 'error') setPollRequested(true);
        compress(localOut, rate, model, controller.signal)
          .then(async (compressed) => {
            if (isStale()) return;
            const counted = await distill(compressed, []);
            if (isStale()) return;
            compressCache.current.set(cacheKey, { text: compressed, tokens: counted.rawTokens });
            if (compressCache.current.size > COMPRESS_CACHE_LIMIT) {
              const oldest = compressCache.current.keys().next().value;
              if (oldest !== undefined) compressCache.current.delete(oldest);
            }
            patch(id, { out: compressed, outTokens: counted.rawTokens, compressing: false });
          })
          .catch(() => {
            if (isStale()) return;
            patch(id, { out: localOut, outTokens: localTokens, compressing: false });
            setLinguaFailed(true);
          });
      };

      const debounced = linguaStarted.current.has(id);
      linguaStarted.current.add(id);
      if (debounced) linguaTimers.current.set(id, setTimeout(run, LINGUA_DEBOUNCE_MS));
      else run();
    }

    if (!linguaActive) setLinguaFailed(false);
  }, [files, linguaActive, rate, model, retryNonce, health, patch]);

  const polling = health?.lingua?.state === 'downloading' || pollRequested;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const interval = setInterval(() => {
      getHealth().then(
        (next) => {
          if (cancelled) return;
          setHealth(next);
          const state = next.lingua?.state;
          if (state === 'ready' || state === 'error') setPollRequested(false);
        },
        () => undefined,
      );
    }, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [polling]);

  const retryLingua = useCallback(() => {
    linguaKeys.current.clear();
    linguaStarted.current.clear();
    compressCache.current.clear();
    setLinguaFailed(false);
    setRetryNonce((current) => current + 1);
  }, []);

  return { files, add, remove, clear, markExported, healthError, health, linguaFailed, retryLingua };
}
