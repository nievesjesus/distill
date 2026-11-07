import { describe, expect, it } from 'vitest';
import { applyShell } from '../src/lib/shell';

describe('applyShell', () => {
  it('marks the document as the desktop shell with its platform', () => {
    const root = document.createElement('html');
    applyShell(root, '?shell=desktop&platform=darwin');
    expect(root.dataset.shell).toBe('desktop');
    expect(root.dataset.platform).toBe('darwin');
  });

  it('does nothing without the query', () => {
    const root = document.createElement('html');
    applyShell(root, '');
    expect(root.dataset.shell).toBeUndefined();
    expect(root.dataset.platform).toBeUndefined();
  });

  it('ignores other shell values', () => {
    const root = document.createElement('html');
    applyShell(root, '?shell=web&platform=darwin');
    expect(Object.keys(root.dataset)).toEqual([]);
  });
});
