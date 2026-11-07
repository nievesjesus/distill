import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dropzone } from '../src/components/Dropzone';

function leave(target: HTMLElement, relatedTarget: EventTarget): void {
  const event = createEvent.dragLeave(target);
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  fireEvent(target, event);
}

function zone(): HTMLElement {
  return document.querySelector('.dropzone') as HTMLElement;
}

describe('Dropzone', () => {
  it('prevents the browser default for drops that miss the zone', () => {
    render(<Dropzone onFiles={() => {}} />);
    const over = createEvent.dragOver(document.body);
    fireEvent(window, over);
    expect(over.defaultPrevented).toBe(true);
    const drop = createEvent.drop(document.body);
    fireEvent(window, drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('stops preventing defaults after unmount', () => {
    const { unmount } = render(<Dropzone onFiles={() => {}} />);
    unmount();
    const drop = createEvent.drop(document.body);
    fireEvent(window, drop);
    expect(drop.defaultPrevented).toBe(false);
  });

  it('keeps the highlight when the drag moves onto a child', () => {
    render(<Dropzone onFiles={() => {}} />);
    fireEvent.dragOver(zone());
    expect(zone()).toHaveAttribute('data-dragging', 'true');
    const child = screen.getByText('PDF · DOCX · PPTX · XLSX · images · parsed locally');
    leave(zone(), child);
    expect(zone()).toHaveAttribute('data-dragging', 'true');
    leave(zone(), document.body);
    expect(zone()).toHaveAttribute('data-dragging', 'false');
  });

  it('adds files dropped anywhere on the window and prevents navigation', async () => {
    const onFiles = vi.fn();
    render(<Dropzone onFiles={onFiles} />);
    const file = new File(['x'], 'outside.pdf');
    const drop = createEvent.drop(document.body, { dataTransfer: { files: [file] } });
    fireEvent(document.body, drop);
    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
  });

  it('highlights the zone while a drag is over the window', () => {
    render(<Dropzone onFiles={() => {}} />);
    fireEvent.dragOver(document.body);
    expect(zone()).toHaveAttribute('data-dragging', 'true');
    const leaving = createEvent.dragLeave(document.body);
    Object.defineProperty(leaving, 'relatedTarget', { value: null });
    fireEvent(document.body, leaving);
    expect(zone()).toHaveAttribute('data-dragging', 'false');
  });

  it('collects files dropped from a dataTransfer', async () => {
    const onFiles = vi.fn();
    render(<Dropzone onFiles={onFiles} />);
    const file = new File(['x'], 'a.pdf');
    fireEvent.drop(zone(), { dataTransfer: { files: [file] } });
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
  });

  it('recurses into dropped folders through webkitGetAsEntry', async () => {
    const onFiles = vi.fn();
    render(<Dropzone onFiles={onFiles} />);
    const inner = new File(['x'], 'inner.pdf');
    const hidden = new File(['x'], '.DS_Store');
    const fileEntry = (file: File) => ({ isFile: true, isDirectory: false, name: file.name, file: (ok: (f: File) => void) => ok(file) });
    const batches = [[fileEntry(inner), fileEntry(hidden)], []];
    const folder = {
      isFile: false,
      isDirectory: true,
      name: 'docs',
      createReader: () => ({ readEntries: (ok: (e: unknown[]) => void) => ok(batches.shift() ?? []) }),
    };
    const items = [{ kind: 'file', webkitGetAsEntry: () => folder, getAsFile: () => null }];
    fireEvent.drop(zone(), { dataTransfer: { items, files: [] } });
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([inner]));
  });

  it('accepts pasted files on window and cleans up on unmount', () => {
    const onFiles = vi.fn();
    const { unmount } = render(<Dropzone onFiles={onFiles} />);
    const file = new File(['x'], 'shot.png');
    const paste = new Event('paste') as Event & { clipboardData: { files: File[] } };
    paste.clipboardData = { files: [file] };
    window.dispatchEvent(paste);
    expect(onFiles).toHaveBeenCalledWith([file]);
    unmount();
    window.dispatchEvent(paste);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });
});
