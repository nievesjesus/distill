import { useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../state/files';
import { S } from '../strings';
import { focusBrowse } from './Dropzone';
import { FileRow } from './FileRow';

interface FileListProps {
  files: FileEntry[];
  detailed?: boolean;
  onRemove?: (localId: string) => void;
  onExported?: (localId: string) => void;
}

export function FileList({ files, detailed = false, onRemove, onExported }: FileListProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const defaultChosen = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const focusIndex = useRef<number | null>(null);
  const firstDone = files.find((file) => file.status === 'done');

  useEffect(() => {
    if (defaultChosen.current || !firstDone) return;
    defaultChosen.current = true;
    setOpenId(firstDone.localId);
  }, [firstDone]);

  useEffect(() => {
    const index = focusIndex.current;
    if (index === null) return;
    focusIndex.current = null;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.remove-button');
    const target = rows?.[Math.min(index, (rows?.length ?? 0) - 1)];
    if (target) target.focus();
    else focusBrowse();
  }, [files]);

  if (files.length === 0) return null;
  return (
    <ul ref={listRef} className="file-list" aria-label={S.files}>
      {files.map((file, index) => (
        <FileRow
          key={file.localId}
          file={file}
          detailed={detailed}
          expanded={openId === file.localId}
          onToggle={() => setOpenId((current) => (current === file.localId ? null : file.localId))}
          onRemove={() => {
            focusIndex.current = index;
            onRemove?.(file.localId);
          }}
          onExported={() => onExported?.(file.localId)}
        />
      ))}
    </ul>
  );
}
