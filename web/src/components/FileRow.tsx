import { savedPercent, shortCount } from '@core/format';
import type { FileEntry } from '../state/files';
import { ERROR_MESSAGES, S } from '../strings';

interface FileRowProps {
  file: FileEntry;
}

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

export function FileRow({ file }: FileRowProps) {
  const kindClass = file.kind ? file.kind.toLowerCase() : 'unknown';
  const isDone = file.status === 'done';
  return (
    <li className="file" data-status={file.status}>
      <div className="file-row">
        <span className="file-main">
          <span className={`kind kind-${kindClass}`}>{file.kind ?? S.unknownKind}</span>
          <span className="file-name" title={file.name}>
            {file.name}
          </span>
          <Status file={file} />
        </span>
        {isDone ? (
          <>
            <button type="button" className="icon-button" aria-label={S.copy} disabled>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
              </svg>
            </button>
            <button type="button" className="icon-button" aria-label={S.download} disabled>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4v11" />
                <path d="M7.5 10.5 12 15l4.5-4.5" />
                <path d="M4 19h16" />
              </svg>
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}
