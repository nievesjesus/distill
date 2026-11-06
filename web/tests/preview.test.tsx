import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileList } from '../src/components/FileList';
import { AnnouncerProvider } from '../src/state/announcer';
import { Footer } from '../src/components/Footer';
import type { FileEntry } from '../src/state/files';

function entry(id: string, name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { localId: id, name, size: 1, kind: 'PDF', status: 'done', out: `out of ${name}`, rawTokens: 10, outTokens: 5, ...overrides };
}

const writeText = vi.fn();
const execCommand = vi.fn();
const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  execCommand.mockReset().mockReturnValue(true);
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('preview expansion', () => {
  it('opens the first done row by default and shows out text', () => {
    render(<FileList files={[entry('1', 'a.pdf'), entry('2', 'b.pdf')]} />);
    expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' })).toHaveTextContent('out of a.pdf');
    expect(screen.queryByRole('region', { name: 'Markdown preview of b.pdf' })).toBeNull();
  });

  it('expands one row at a time', () => {
    render(<FileList files={[entry('1', 'a.pdf'), entry('2', 'b.pdf')]} />);
    fireEvent.click(screen.getByRole('button', { name: /b\.pdf/ }));
    expect(screen.queryByRole('region', { name: 'Markdown preview of a.pdf' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Markdown preview of b.pdf' })).toBeInTheDocument();
  });

  it('links the toggle to the preview with aria-expanded and aria-controls', () => {
    render(<FileList files={[entry('1', 'a.pdf')]} />);
    const toggle = screen.getByRole('button', { name: /a\.pdf/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const preview = screen.getByRole('region', { name: 'Markdown preview of a.pdf' });
    expect(toggle.getAttribute('aria-controls')).toBe(preview.id);
    expect(preview).toHaveAttribute('tabindex', '0');
  });

  it('chooses the default row only once', () => {
    const first = entry('1', 'a.pdf');
    const { rerender } = render(<FileList files={[first]} />);
    fireEvent.click(screen.getByRole('button', { name: /a\.pdf/ }));
    expect(screen.queryByRole('region', { name: 'Markdown preview of a.pdf' })).toBeNull();
    rerender(<FileList files={[first, entry('2', 'b.pdf')]} />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('opens the first row that reaches done after earlier rows were not done', () => {
    const queued = entry('1', 'a.pdf', { status: 'queued', out: undefined });
    const { rerender } = render(<FileList files={[queued]} />);
    expect(screen.queryByRole('region')).toBeNull();
    rerender(<FileList files={[entry('1', 'a.pdf')]} />);
    expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' })).toBeInTheDocument();
  });

  it('does not let error or pending rows expand', () => {
    const files = [
      entry('1', 'bad.pdf', { status: 'error', out: undefined, error: { code: 'parse_failed', message: 'x' } }),
      entry('2', 'wait.pdf', { status: 'parsing', out: undefined }),
    ];
    render(<FileList files={files} />);
    expect(screen.queryByRole('button', { name: /bad\.pdf/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /wait\.pdf/ })).toBeNull();
    expect(document.querySelector('[aria-expanded]')).toBeNull();
  });

  it('uses the taller preview in detailed mode', () => {
    render(<FileList files={[entry('1', 'a.pdf')]} detailed />);
    expect(document.querySelector('.preview')).toHaveAttribute('data-detailed', 'true');
  });
});

describe('copy', () => {
  it('writes out to the clipboard and flips the label for 1.5 s', async () => {
    vi.useFakeTimers();
    render(<FileList files={[entry('1', 'a.pdf')]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    });
    expect(writeText).toHaveBeenCalledWith('out of a.pdf');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button', { name: 'Copy Markdown' })).toBeInTheDocument();
  });

  it('falls back to execCommand when the clipboard rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<FileList files={[entry('1', 'a.pdf')]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    });
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('announces a copy failure while the visible message has no role', async () => {
    vi.useFakeTimers();
    writeText.mockRejectedValue(new Error('denied'));
    execCommand.mockReturnValue(false);
    render(
      <AnnouncerProvider>
        <FileList files={[entry('1', 'a.pdf')]} />
      </AnnouncerProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed — select the preview text instead');
    expect(screen.getByText('Copy failed — select the preview text instead', { selector: 'p' })).not.toHaveAttribute('role');
  });

  it('shows the failure message for 3 s when both paths fail', async () => {
    vi.useFakeTimers();
    writeText.mockRejectedValue(new Error('denied'));
    execCommand.mockReturnValue(false);
    render(<FileList files={[entry('1', 'a.pdf')]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    });
    expect(screen.getByText('Copy failed — select the preview text instead')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText(/Copy failed/)).toBeNull();
  });

  it('clears the copied timer on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<FileList files={[entry('1', 'a.pdf')]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('download', () => {
  it('downloads a single file as markdown with a .md name', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('Informe Año 📊.md');
    });
    vi.useFakeTimers();
    render(<FileList files={[entry('1', 'Informe Año 📊.pdf')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Markdown' }));
    expect(click).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    click.mockRestore();
  });

  it('disables Download all without done rows', () => {
    render(<Footer files={[entry('1', 'a.pdf', { status: 'queued', out: undefined })]} />);
    expect(screen.getByRole('button', { name: 'Download all' })).toBeDisabled();
  });

  it('Download all zips only done files with unique names', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toMatch(/^distill-\d{4}-\d{2}-\d{2}\.zip$/);
    });
    const files = [
      entry('1', 'A.pdf', { out: 'one' }),
      entry('2', 'a.docx', { out: 'two' }),
      entry('3', 'bad.pdf', { status: 'error', out: undefined }),
      entry('4', 'dir/c.pdf', { out: 'três 📊' }),
    ];
    render(<Footer files={files} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    });
    const blob = createObjectURL.mock.calls[0][0];
    const unzipped = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(unzipped).sort()).toEqual(['A.md', 'a (2).md', 'c.md']);
    expect(strFromU8(unzipped['A.md'])).toBe('one');
    expect(strFromU8(unzipped['a (2).md'])).toBe('two');
    expect(strFromU8(unzipped['c.md'])).toBe('três 📊');
    click.mockRestore();
    expect(within(screen.getByRole('contentinfo')).getByText(/3\/4 files/)).toBeInTheDocument();
  });
});
