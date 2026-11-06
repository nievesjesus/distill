import { describe, expect, it } from 'vitest';
import { createStore, type StoredFile } from '../../src/server/store';

function entry(id: string, size = 1): StoredFile {
  return { id, name: `${id}.pdf`, kind: 'PDF', bytes: new Uint8Array(size), markdown: id };
}

describe('store', () => {
  it('evicts least recently used past maxFiles', () => {
    const store = createStore({ maxFiles: 2, maxBytes: 1000 });
    store.put(entry('a'));
    store.put(entry('b'));
    store.get('a');
    store.put(entry('c'));
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });

  it('evicts past maxBytes', () => {
    const store = createStore({ maxFiles: 10, maxBytes: 10 });
    store.put(entry('a', 6));
    store.put(entry('b', 6));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });

  it('keeps a single entry larger than maxBytes', () => {
    const store = createStore({ maxFiles: 10, maxBytes: 5 });
    store.put(entry('big', 9));
    expect(store.get('big')).toBeDefined();
  });

  it('replaces an entry with the same id without double counting bytes', () => {
    const store = createStore({ maxFiles: 10, maxBytes: 10 });
    store.put(entry('a', 6));
    store.put(entry('a', 6));
    store.put(entry('b', 4));
    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeDefined();
  });
});
