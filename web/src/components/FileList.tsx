import type { FileEntry } from '../state/files';
import { S } from '../strings';
import { FileRow } from './FileRow';

interface FileListProps {
  files: FileEntry[];
}

export function FileList({ files }: FileListProps) {
  if (files.length === 0) return null;
  return (
    <ul className="file-list" aria-label={S.files} aria-live="polite" aria-relevant="additions">
      {files.map((file) => (
        <FileRow key={file.localId} file={file} />
      ))}
    </ul>
  );
}
