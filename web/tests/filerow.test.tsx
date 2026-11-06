import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileRow } from '../src/components/FileRow';
import type { FileEntry } from '../src/state/files';

const queued: FileEntry = { localId: 'f1', name: 'a.xyz', size: 1, kind: null, status: 'queued' };

describe('FileRow', () => {
  it('remounts the status node when a queued row becomes an error', () => {
    const { rerender } = render(<ul><FileRow file={queued} /></ul>);
    const previous = screen.getByText('Queued');
    rerender(
      <ul>
        <FileRow file={{ ...queued, status: 'error', error: { code: 'unsupported_type', message: 'x' } }} />
      </ul>,
    );
    const error = document.querySelector('.file-error');
    expect(error).not.toBeNull();
    expect(error).not.toBe(previous);
    expect(previous.isConnected).toBe(false);
    expect(error).toHaveTextContent('This file type is not supported.');
  });
});
