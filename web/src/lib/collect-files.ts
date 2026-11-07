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

export async function collectFiles(transfer: DataTransfer): Promise<File[]> {
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
