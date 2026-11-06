import { useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../state/files';
import { S } from '../strings';
import { FileRow } from './FileRow';

interface FileListProps {
  files: FileEntry[];
  detailed?: boolean;
}

export function FileList({ files, detailed = false }: FileListProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const defaultChosen = useRef(false);
  const firstDone = files.find((file) => file.status === 'done');

  useEffect(() => {
    if (defaultChosen.current || !firstDone) return;
    defaultChosen.current = true;
    setOpenId(firstDone.localId);
  }, [firstDone]);

  if (files.length === 0) return null;
  return (
    <ul className="file-list" aria-label={S.files} aria-live="polite" aria-relevant="additions">
      {files.map((file) => (
        <FileRow
          key={file.localId}
          file={file}
          detailed={detailed}
          expanded={openId === file.localId}
          onToggle={() => setOpenId((current) => (current === file.localId ? null : file.localId))}
        />
      ))}
    </ul>
  );
}
