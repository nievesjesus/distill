import { useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { S } from '../strings';

interface DropzoneProps {
  onFiles: (files: File[]) => void;
}

export function Dropzone({ onFiles }: DropzoneProps) {
  const inputId = useId();
  const formatsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
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
      onDragLeave={() => setDragging(false)}
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
