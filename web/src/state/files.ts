import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, ErrorCode, FileKind } from '@core/types';
import { detectKind } from '@core/kind';
import { getHealth, parseFile } from '../api';
import { distill } from '../worker/client';
import type { Settings } from './settings';

export const MAX_CONCURRENT_UPLOADS = 3;

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
}

export interface FilesApi {
  files: FileEntry[];
  add: (files: File[]) => void;
  healthError: ApiError | null;
}

const KNOWN_CODES: readonly ErrorCode[] = [
  'unsupported_type',
  'needs_libreoffice',
  'too_large',
  'password_protected',
  'timeout',
  'parse_failed',
  'bad_request',
  'not_found',
  'lingua_unavailable',
  'forbidden',
];

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

function clientError(code: ErrorCode): ApiError {
  return { code, message: code };
}

export function useFiles(settings: Settings): FilesApi {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [healthError, setHealthError] = useState<ApiError | null>(null);
  const blobs = useRef(new Map<string, File>());
  const started = useRef(new Set<string>());
  const appliedKey = useRef(new Map<string, string>());
  const requestCounter = useRef(new Map<string, number>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getHealth().then(
      (health) => {
        if (!cancelled) setMaxBytes(health.maxBytes);
      },
      (error: unknown) => {
        if (!cancelled) setHealthError(toApiError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback((localId: string, changes: Partial<FileEntry>) => {
    if (!mounted.current) return;
    setFiles((current) => current.map((entry) => (entry.localId === localId ? { ...entry, ...changes } : entry)));
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
      parseFile(blob).then(
        (response) => {
          blobs.current.delete(entry.localId);
          patch(entry.localId, { status: 'done', serverId: response.id, raw: response.markdown });
        },
        (error: unknown) => {
          blobs.current.delete(entry.localId);
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
        patch(entry.localId, { out: raw, outTokens: entry.rawTokens });
        continue;
      }

      const ticket = (requestCounter.current.get(entry.localId) ?? 0) + 1;
      requestCounter.current.set(entry.localId, ticket);
      distill(raw, boosters).then(
        (result) => {
          if (requestCounter.current.get(entry.localId) !== ticket) return;
          if (boosters.length === 0) patch(entry.localId, { out: raw, rawTokens: result.rawTokens, outTokens: result.rawTokens });
          else patch(entry.localId, { out: result.out, rawTokens: result.rawTokens, outTokens: result.outTokens });
        },
        (error: unknown) => {
          if (requestCounter.current.get(entry.localId) !== ticket) return;
          patch(entry.localId, { status: 'error', error: toApiError(error) });
        },
      );
    }
  }, [files, settings.optimize, settings.active, settingsKey, patch]);

  return { files, add, healthError };
}
