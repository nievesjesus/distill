import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { S } from '../strings';

interface DropzoneProps {
  onFiles: (files: File[]) => void;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, failure: (error: unknown) => void) => void;
  };
}

type EntryItem = DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null };

function readFile(entry: FileSystemEntryLike): Promise<File[]> {
  return new Promise((resolve) => {
    entry.file?.(
      (file) => resolve([file]),
      () => resolve([]),
    );
  });
}

function readBatch(reader: NonNullable<ReturnType<NonNullable<FileSystemEntryLike['createReader']>>>): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve) => {
    reader.readEntries(resolve, () => resolve([]));
  });
}

async function readDirectory(entry: FileSystemEntryLike): Promise<File[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const children: FileSystemEntryLike[] = [];
  for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
    children.push(...batch);
  }
  return (await Promise.all(children.map(readEntry))).flat();
}

async function readEntry(entry: FileSystemEntryLike): Promise<File[]> {
  if (entry.name.startsWith('.')) return [];
  if (entry.isFile) return readFile(entry);
  if (entry.isDirectory) return readDirectory(entry);
  return [];
}

async function collectFiles(transfer: DataTransfer): Promise<File[]> {
  const items = Array.from(transfer.items ?? []) as EntryItem[];
  const entries = items.map((item) => ({
    entry: item.kind === 'file' ? (item.webkitGetAsEntry?.() ?? null) : null,
    file: item.kind === 'file' ? item.getAsFile() : null,
  }));
  if (entries.length === 0) return Array.from(transfer.files);
  const groups = await Promise.all(
    entries.map(({ entry, file }) => {
      if (entry) return readEntry(entry);
      return Promise.resolve(file ? [file] : []);
    }),
  );
  return groups.flat();
}

function preventDefault(event: Event): void {
  event.preventDefault();
}

export function Dropzone({ onFiles }: DropzoneProps) {
  const inputId = useId();
  const formatsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
      window.removeEventListener('paste', handlePaste);
    };
  }, []);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    collectFiles(event.dataTransfer).then((files) => {
      if (files.length > 0) onFilesRef.current(files);
    });
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  return (
    <div
      className="dropzone"
      data-dragging={dragging}
      aria-describedby={formatsId}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span className="dropzone-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15V4" />
          <path d="M7.5 8.5 12 4l4.5 4.5" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
      </span>
      <span className="dropzone-text">
        <span className="dropzone-title">
          {S.drop} <span className="dropzone-or">{S.or}</span>{' '}
          <button type="button" className="dropzone-browse" onClick={() => inputRef.current?.click()}>
            {S.browse}
          </button>
        </span>
        <span id={formatsId} className="dropzone-formats">
          {S.formats}
        </span>
      </span>
      <label htmlFor={inputId} className="visually-hidden">
        {S.fileInput}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className="visually-hidden"
        type="file"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}
