import type { FileKind } from '../core/types';

export interface StoredFile {
  id: string;
  name: string;
  kind: FileKind;
  bytes: Uint8Array;
  markdown: string;
}

export interface Store {
  put(entry: StoredFile): void;
  get(id: string): StoredFile | undefined;
}

export function createStore(opts: { maxFiles: number; maxBytes: number }): Store {
  const entries = new Map<string, StoredFile>();
  let totalBytes = 0;

  const remove = (id: string) => {
    const existing = entries.get(id);
    if (!existing) return;
    totalBytes -= existing.bytes.byteLength;
    entries.delete(id);
  };

  const evict = () => {
    while (entries.size > 1 && (entries.size > opts.maxFiles || totalBytes > opts.maxBytes)) {
      const oldest = entries.keys().next().value as string;
      remove(oldest);
    }
  };

  return {
    put(entry) {
      remove(entry.id);
      entries.set(entry.id, entry);
      totalBytes += entry.bytes.byteLength;
      evict();
    },
    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      entries.delete(id);
      entries.set(id, entry);
      return entry;
    },
  };
}
