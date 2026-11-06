import { useEffect, useRef, useState } from 'react';
import { savedPercent, shortCount } from '@core/format';
import { useAnnounce } from '../state/announcer';
import { copyText } from '../lib/clipboard';
import { downloadText } from '../lib/download';
import { mdName } from '../lib/names';
import type { FileEntry } from '../state/files';
import { ERROR_MESSAGES, S } from '../strings';
import { Preview } from './Preview';

interface FileRowProps {
  file: FileEntry;
  expanded?: boolean;
  detailed?: boolean;
  onToggle?: () => void;
}

const COPIED_MS = 1500;
const FAILED_MS = 3000;

type CopyState = 'idle' | 'copied' | 'failed';

function Tokens({ file }: FileRowProps) {
  if (file.rawTokens === undefined || file.outTokens === undefined) return null;
  const saved = savedPercent(file.rawTokens, file.outTokens);
  if (saved === 0) {
    return <span className="file-tokens">{shortCount(file.rawTokens)} {S.tokensSuffix}</span>;
  }
  return (
    <>
      <span className="file-tokens">
        {shortCount(file.rawTokens)} → {shortCount(file.outTokens)}
      </span>
      <span className="file-saved">−{saved}%</span>
    </>
  );
}

function Status({ file }: FileRowProps) {
  if (file.status === 'error' && file.error) {
    return <span key="error" className="file-error">{ERROR_MESSAGES[file.error.code]}</span>;
  }
  if (file.status === 'queued') return <span key="queued" className="file-status">{S.queued}</span>;
  if (file.status === 'parsing') {
    return (
      <span key="parsing" className="file-status">
        <span className="progress" aria-hidden="true">
          <span className="progress-bar" />
        </span>
        {file.kind === 'IMG' ? S.ocr : <span className="visually-hidden">{S.parsing}</span>}
      </span>
    );
  }
  return <Tokens key="done" file={file} />;
}

function useCopy(text: string) {
  const announce = useAnnounce();
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    const ok = await copyText(text);
    if (timer.current) clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    if (!ok) announce(S.copyFailed);
    timer.current = setTimeout(() => setState('idle'), ok ? COPIED_MS : FAILED_MS);
  };

  return { state, copy };
}

function FileMain({ file }: { file: FileEntry }) {
  const kindClass = file.kind ? file.kind.toLowerCase() : 'unknown';
  return (
    <>
      <span className={`kind kind-${kindClass}`}>{file.kind ?? S.unknownKind}</span>
      <span className="file-name" title={file.name}>
        {file.name}
      </span>
      <Status file={file} />
    </>
  );
}

function DoneActions({ file }: { file: FileEntry }) {
  const out = file.out ?? '';
  const { state, copy } = useCopy(out);
  const copied = state === 'copied';
  return (
    <>
      <button
        type="button"
        className={copied ? 'icon-button is-copied' : 'icon-button'}
        aria-label={copied ? S.copied : S.copy}
        onClick={copy}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      </button>
      <button type="button" className="icon-button" aria-label={S.download} onClick={() => downloadText(mdName(file.name), out)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11" />
          <path d="M7.5 10.5 12 15l4.5-4.5" />
          <path d="M4 19h16" />
        </svg>
      </button>
      {state === 'failed' ? (
        <p className="copy-failed">
          {S.copyFailed}
        </p>
      ) : null}
    </>
  );
}

export function FileRow({ file, expanded = false, detailed = false, onToggle }: FileRowProps) {
  const isDone = file.status === 'done';
  const previewId = `preview-${file.localId}`;
  const isOpen = isDone && expanded;
  return (
    <li className="file" data-status={file.status}>
      <div className="file-row">
        {isDone ? (
          <button type="button" className="file-main file-toggle" aria-expanded={isOpen} aria-controls={previewId} onClick={onToggle}>
            <FileMain file={file} />
          </button>
        ) : (
          <span className="file-main">
            <FileMain file={file} />
          </span>
        )}
        {isDone ? <DoneActions file={file} /> : null}
      </div>
      {isOpen ? <Preview id={previewId} name={file.name} text={file.out ?? ''} detailed={detailed} /> : null}
    </li>
  );
}
