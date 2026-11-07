import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBoosterId } from '@core/types';
import { App } from '../src/App';
import { Dropzone } from '../src/components/Dropzone';
import { EmptyState } from '../src/components/EmptyState';
import { FileList } from '../src/components/FileList';
import { FileRow } from '../src/components/FileRow';
import { Footer } from '../src/components/Footer';
import { useExportTracking } from '../src/lib/desktop-bridge';
import { AnnouncerProvider } from '../src/state/announcer';
import type { FileEntry } from '../src/state/files';

const distillMock = vi.hoisted(() => vi.fn());

vi.mock('../src/worker/client', () => ({ distill: distillMock, forgetRaw: vi.fn() }));

function entry(id: string, name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { localId: id, name, size: 1, kind: 'PDF', status: 'done', out: `out of ${name}`, rawTokens: 10, outTokens: 5, ...overrides };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:fake'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (window as { distillDesktop?: unknown }).distillDesktop;
  delete document.documentElement.dataset.shell;
  delete document.documentElement.dataset.platform;
});

describe('FileRow removal', () => {
  it('has a labelled remove button on every status', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<ul><FileRow file={entry('1', 'a.pdf')} onRemove={onRemove} /></ul>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    for (const status of ['queued', 'parsing', 'error'] as const) {
      rerender(<ul><FileRow file={entry('1', 'a.pdf', { status, error: { code: 'parse_failed', message: 'x' } })} onRemove={onRemove} /></ul>);
      expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeInTheDocument();
    }
  });

  const toggle = () => document.querySelector('.file-toggle') as HTMLElement;

  it('removes the row on Delete from the row toggle', () => {
    const onRemove = vi.fn();
    render(<ul><FileRow file={entry('1', 'a.pdf')} onRemove={onRemove} /></ul>);
    fireEvent.keyDown(toggle(), { key: 'Delete' });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])('removes the row on Backspace with %o from the row toggle', (modifier) => {
    const onRemove = vi.fn();
    render(<ul><FileRow file={entry('1', 'a.pdf')} onRemove={onRemove} /></ul>);
    fireEvent.keyDown(toggle(), { key: 'Backspace', ...modifier });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('never removes on a plain Backspace', () => {
    const onRemove = vi.fn();
    render(<ul><FileRow file={entry('1', 'a.pdf')} onRemove={onRemove} /></ul>);
    fireEvent.keyDown(toggle(), { key: 'Backspace' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Copy Markdown' }), { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('does not remove on Delete from the action buttons', () => {
    const onRemove = vi.fn();
    render(<ul><FileRow file={entry('1', 'a.pdf')} onRemove={onRemove} /></ul>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Copy Markdown' }), { key: 'Delete' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Download Markdown' }), { key: 'Delete' });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const onRemove = vi.fn();
    render(<ul><FileRow file={entry('1', 'a.pdf')} onRemove={onRemove} /></ul>);
    fireEvent.keyDown(toggle(), { key: 'a' });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('offers only Remove until the distilled Markdown exists', () => {
    render(<ul><FileRow file={entry('1', 'a.pdf', { out: undefined })} /></ul>);
    expect(screen.queryByRole('button', { name: 'Copy Markdown' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Markdown' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeInTheDocument();
  });

  it('reports exports from copy and single download', async () => {
    const onExported = vi.fn();
    render(<ul><FileRow file={entry('1', 'a.pdf')} onExported={onExported} /></ul>);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    });
    expect(onExported).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Download Markdown' }));
    expect(onExported).toHaveBeenCalledTimes(2);
  });
});

describe('focus after removal', () => {
  function Harness({ initial }: { initial: FileEntry[] }) {
    const [files, setFiles] = useState(initial);
    return (
      <>
        <Dropzone onFiles={() => undefined} />
        <FileList files={files} onRemove={(id) => setFiles((current) => current.filter((file) => file.localId !== id))} />
      </>
    );
  }

  const three = [entry('1', 'a.pdf'), entry('2', 'b.pdf'), entry('3', 'c.pdf')];

  it('moves to the next row', () => {
    render(<Harness initial={three} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }));
    expect(screen.getByRole('button', { name: 'Remove c.pdf' })).toHaveFocus();
  });

  it('moves to the previous row when the last one goes', () => {
    render(<Harness initial={three} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove c.pdf' }));
    expect(screen.getByRole('button', { name: 'Remove b.pdf' })).toHaveFocus();
  });

  it('moves to browse when the list empties', () => {
    render(<Harness initial={[entry('1', 'a.pdf')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(screen.getByRole('button', { name: 'browse' })).toHaveFocus();
  });
});

describe('Footer clear', () => {
  it('clears immediately when everything was exported', () => {
    const onClear = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<Footer files={[entry('1', 'a.pdf', { exported: true })]} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks inline when results were not exported, and Cancel keeps the list', () => {
    const onClear = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<Footer files={[entry('1', 'a.pdf', { exported: true }), entry('2', 'b.pdf'), entry('3', 'c.pdf')]} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).not.toHaveBeenCalled();
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('Clear 3 files? 2 not saved yet.')).toBeInTheDocument();
    fireEvent.click(within(footer).getByRole('button', { name: 'Cancel' }));
    expect(within(footer).queryByText(/not saved yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveFocus();
    expect(onClear).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('confirms with the second Clear', () => {
    const onClear = vi.fn();
    render(<Footer files={[entry('1', 'a.pdf')]} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Clear 1 file? 1 not saved yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels the confirmation', () => {
    const onClear = vi.fn();
    render(<Footer files={[entry('1', 'a.pdf')]} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('marks done files as exported after Download all', async () => {
    const onExported = vi.fn();
    render(<Footer files={[entry('1', 'a.pdf'), entry('2', 'b.pdf', { status: 'error' })]} onExported={onExported} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    });
    expect(onExported).toHaveBeenCalledWith(['1'], expect.stringMatching(/^distill-\d{4}-\d{2}-\d{2}\.zip$/));
  });

  it('does not mark anything exported when building the ZIP fails', async () => {
    const onExported = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => { throw new Error('boom'); }), configurable: true });
    render(<Footer files={[entry('1', 'a.pdf')]} onExported={onExported} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    });
    expect(onExported).not.toHaveBeenCalled();
  });

  it('announces a ZIP build failure', async () => {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => { throw new Error('boom'); }), configurable: true });
    render(
      <AnnouncerProvider>
        <Footer files={[entry('1', 'a.pdf')]} />
      </AnnouncerProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not build the ZIP'));
  });

  it('keeps Download all disabled and exports nothing while no row has its Markdown yet', () => {
    const onExported = vi.fn();
    render(<Footer files={[entry('1', 'a.pdf', { out: undefined }), entry('2', 'b.pdf', { out: undefined })]} onExported={onExported} />);
    expect(screen.getByRole('button', { name: 'Download all' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    expect(onExported).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('zips only rows whose Markdown exists', async () => {
    const onExported = vi.fn();
    render(<Footer files={[entry('1', 'a.pdf'), entry('2', 'b.pdf', { out: undefined })]} onExported={onExported} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    });
    expect(onExported).toHaveBeenCalledWith(['1'], expect.any(String));
  });

  it('does not come back in confirm mode after the list empties', () => {
    const { rerender } = render(<Footer files={[entry('1', 'a.pdf')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/not saved yet/)).toBeInTheDocument();
    rerender(<Footer files={[]} />);
    rerender(<Footer files={[entry('2', 'b.pdf')]} />);
    expect(screen.queryByText(/not saved yet/)).toBeNull();
  });

  it('ignores Escape that belongs to an open dialog or was already handled', () => {
    render(
      <>
        <dialog open><button type="button">inside</button></dialog>
        <Footer files={[entry('1', 'a.pdf')]} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside' }), { key: 'Escape' });
    expect(screen.getByText(/not saved yet/)).toBeInTheDocument();
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    expect(screen.getByText(/not saved yet/)).toBeInTheDocument();
  });
});

describe('export tracking on desktop', () => {
  function Probe({ commit }: { commit: (ids: string[]) => void }) {
    const track = useExportTracking(commit);
    return (
      <>
        <button type="button" onClick={() => track(['1'], 'a.md')}>download</button>
        <button type="button" onClick={() => track(['2'])}>copy</button>
      </>
    );
  }

  function bridge() {
    let listener: ((saved: { id: string; filename: string }) => void) | undefined;
    (window as { distillDesktop?: unknown }).distillDesktop = {
      onSaved: (callback: typeof listener) => {
        listener = callback;
        return () => undefined;
      },
      reveal: () => undefined,
    };
    return (saved: { id: string; filename: string }) => act(() => listener?.(saved));
  }

  it('marks a download only when the save is confirmed, and a copy at once', () => {
    const emit = bridge();
    const commit = vi.fn();
    render(<Probe commit={commit} />);
    fireEvent.click(screen.getByRole('button', { name: 'download' }));
    expect(commit).not.toHaveBeenCalled();
    emit({ id: 'x', filename: 'a.md' });
    expect(commit).toHaveBeenCalledWith(['1']);
    fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    expect(commit).toHaveBeenLastCalledWith(['2']);
  });

  it('marks nothing for a cancelled save and ignores unrelated saves', () => {
    const emit = bridge();
    const commit = vi.fn();
    render(<Probe commit={commit} />);
    fireEvent.click(screen.getByRole('button', { name: 'download' }));
    emit({ id: 'x', filename: 'bundle.zip' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('marks at once in the browser shell', () => {
    const commit = vi.fn();
    render(<Probe commit={commit} />);
    fireEvent.click(screen.getByRole('button', { name: 'download' }));
    expect(commit).toHaveBeenCalledWith(['1']);
  });

});

describe('saved notice', () => {
  function stubBridge() {
    let listener: ((saved: { id: string; filename: string }) => void) | undefined;
    const reveal = vi.fn();
    const unsubscribe = vi.fn();
    (window as { distillDesktop?: unknown }).distillDesktop = {
      onSaved: (callback: typeof listener) => {
        listener = callback;
        return unsubscribe;
      },
      reveal,
    };
    return { emit: (saved: { id: string; filename: string }) => act(() => listener?.(saved)), reveal, unsubscribe };
  }

  it('shows Saved with Show in Finder on macOS and reveals by id', () => {
    document.documentElement.dataset.platform = 'darwin';
    const bridge = stubBridge();
    render(<Footer files={[entry('1', 'a.pdf')]} />);
    expect(screen.queryByText(/^Saved/)).toBeNull();
    bridge.emit({ id: 'id-1', filename: 'out.md' });
    expect(screen.getByText('Saved out.md')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(bridge.reveal).toHaveBeenCalledWith('id-1');
  });

  it('says Show in folder elsewhere', () => {
    document.documentElement.dataset.platform = 'win32';
    const bridge = stubBridge();
    render(<Footer files={[entry('1', 'a.pdf')]} />);
    bridge.emit({ id: 'id-1', filename: 'out.md' });
    expect(screen.getByRole('button', { name: 'Show in folder' })).toBeInTheDocument();
  });

  it('goes away after about six seconds', () => {
    vi.useFakeTimers();
    const bridge = stubBridge();
    render(<Footer files={[entry('1', 'a.pdf')]} />);
    bridge.emit({ id: 'id-1', filename: 'out.md' });
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(screen.getByText('Saved out.md')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Saved out.md')).toBeNull();
  });

  it('goes away with Escape and unsubscribes on unmount', () => {
    const bridge = stubBridge();
    const { unmount } = render(<Footer files={[entry('1', 'a.pdf')]} />);
    bridge.emit({ id: 'id-1', filename: 'out.md' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Saved out.md')).toBeNull();
    unmount();
    expect(bridge.unsubscribe).toHaveBeenCalled();
  });

  it('does nothing without a bridge', () => {
    render(<Footer files={[entry('1', 'a.pdf')]} />);
    expect(screen.queryByText(/^Saved/)).toBeNull();
  });
});

describe('EmptyState', () => {
  it('shows the browser copy, the type chips and a Browse files button', () => {
    const onBrowse = vi.fn();
    render(<EmptyState dragging={false} onBrowse={onBrowse} />);
    expect(screen.getByText('Nothing distilled yet')).toBeInTheDocument();
    expect(screen.getByText('Drop documents here — they never leave your machine.')).toBeInTheDocument();
    for (const label of ['PDF', 'DOCX', 'PPTX', 'XLSX', 'IMG']) expect(screen.getByText(label)).toHaveClass('kind');
    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.empty-art')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says anywhere in this window on desktop', () => {
    document.documentElement.dataset.shell = 'desktop';
    render(<EmptyState dragging={false} onBrowse={() => undefined} />);
    expect(screen.getByText('Drop documents anywhere in this window — they never leave your machine.')).toBeInTheDocument();
  });

  it('highlights while dragging', () => {
    const { rerender } = render(<EmptyState dragging={false} onBrowse={() => undefined} />);
    expect(document.querySelector('.empty-state')).toHaveAttribute('data-dragging', 'false');
    rerender(<EmptyState dragging onBrowse={() => undefined} />);
    expect(document.querySelector('.empty-state')).toHaveAttribute('data-dragging', 'true');
  });
});

describe('App list management', () => {
  const RAW = 'x'.repeat(2000);
  let calls: Array<{ url: string; method: string }>;

  beforeEach(() => {
    localStorage.clear();
    calls = [];
    distillMock.mockReset();
    distillMock.mockImplementation(async (raw: string, active: LocalBoosterId[]) => ({ out: raw.slice(active.length), rawTokens: raw.length, outTokens: raw.length - active.length }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url === '/api/health') return Response.json({ version: '1', liteparseVersion: '1', libreoffice: false, maxBytes: 100000, lingua: { installed: false } });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        const name = ((init?.body as FormData).get('file') as File).name;
        return Response.json({ id: `srv-${name}`, name, kind: 'PDF', pages: 1, markdown: RAW, ms: 1 });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  function drop(names: string[]) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: names.map((name) => new File(['x'], name)) } });
  }

  it('shows the empty state and no footer until a file arrives, then swaps them', async () => {
    render(<App />);
    expect(screen.getByText('Nothing distilled yet')).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    drop(['a.pdf']);
    await waitFor(() => expect(screen.getByRole('contentinfo')).toBeInTheDocument());
    expect(screen.queryByText('Nothing distilled yet')).toBeNull();
  });

  it('Browse files in the empty state opens the same file input', () => {
    render(<App />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('removes a row, announces it, tells the server and keeps the others', async () => {
    render(<App />);
    drop(['a.pdf', 'b.pdf']);
    await waitFor(() => expect(document.querySelectorAll('.file-tokens')).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(screen.queryByRole('button', { name: 'Remove a.pdf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove b.pdf' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('a.pdf removed'));
    expect(calls).toContainEqual({ url: '/api/files/srv-a.pdf', method: 'DELETE' });
  });

  it('Clear confirms when nothing was exported, then empties the list and the server', async () => {
    render(<App />);
    drop(['a.pdf', 'b.pdf']);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copy Markdown' })).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Clear 2 files? 2 not saved yet.')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('contentinfo')).getAllByRole('button', { name: 'Clear' })[0]);
    expect(screen.getByText('Nothing distilled yet')).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    await waitFor(() => {
      expect(calls).toContainEqual({ url: '/api/files/srv-a.pdf', method: 'DELETE' });
      expect(calls).toContainEqual({ url: '/api/files/srv-b.pdf', method: 'DELETE' });
    });
    expect(calls).not.toContainEqual({ url: '/api/files', method: 'DELETE' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'browse' })).toHaveFocus());
  });

  it('moves focus to browse when the only row is removed', async () => {
    render(<App />);
    drop(['a.pdf']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(screen.getByText('Nothing distilled yet')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'browse' })).toHaveFocus());
  });

  it('does not ask after the results were downloaded', async () => {
    render(<App />);
    drop(['a.pdf']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download all' })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Nothing distilled yet')).toBeInTheDocument();
  });
});
