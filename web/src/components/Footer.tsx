import { useEffect, useRef, useState } from 'react';
import { savedPercent, shortCount } from '@core/format';
import type { FileEntry } from '../state/files';
import { revealLabel, useSavedNotice } from '../lib/desktop-bridge';
import { downloadZip } from '../lib/download';
import { mdName, uniqueNames } from '../lib/names';
import { S } from '../strings';

interface FooterProps {
  files: FileEntry[];
  onClear?: () => void;
  onExported?: (localIds: string[]) => void;
}

export function Footer({ files, onClear, onExported }: FooterProps) {
  const [confirming, setConfirming] = useState(false);
  const clearRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { saved, dismiss, reveal } = useSavedNotice();
  const active = confirming || saved !== null;

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirming) {
        setConfirming(false);
        requestAnimationFrame(() => clearRef.current?.focus());
      } else {
        dismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, confirming, dismiss]);

  if (files.length === 0) return null;
  const done = files.filter((file) => file.status === 'done');
  const unsaved = done.filter((file) => !file.exported).length;
  const measured = done.filter((file) => file.rawTokens !== undefined && file.outTokens !== undefined);
  const raw = measured.reduce((sum, file) => sum + (file.rawTokens ?? 0), 0);
  const out = measured.reduce((sum, file) => sum + (file.outTokens ?? 0), 0);
  const saving = savedPercent(raw, out);

  const downloadAll = () => {
    const names = uniqueNames(done.map((file) => mdName(file.name)));
    void downloadZip(done.map((file, index) => ({ name: names[index], text: file.out ?? '' })));
    onExported?.(done.map((file) => file.localId));
  };

  const requestClear = () => {
    if (unsaved === 0) {
      onClear?.();
      return;
    }
    setConfirming(true);
  };

  const confirmClear = () => {
    setConfirming(false);
    onClear?.();
  };

  return (
    <footer className="footer">
      {saved ? (
        <p className="footer-saved" role="status">
          <span className="footer-saved-text">{S.saved(saved.filename)}</span>
          <button type="button" className="footer-link" onClick={reveal}>
            {revealLabel()}
          </button>
        </p>
      ) : null}
      {confirming ? (
        <>
          <p className="footer-confirm" role="alert">
            {S.clearConfirm(files.length, unsaved)}
          </p>
          <div className="footer-actions">
            <button ref={cancelRef} type="button" className="footer-button" onClick={() => setConfirming(false)}>
              {S.cancel}
            </button>
            <button type="button" className="footer-button footer-button-danger" onClick={confirmClear}>
              {S.clear}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="footer-total">
            <span className="footer-pct">{saving > 0 ? `−${saving}%` : '0%'}</span>
            <span className="footer-line">{S.footerLine(shortCount(raw), shortCount(out), done.length, files.length)}</span>
          </div>
          <div className="footer-actions">
            <button ref={clearRef} type="button" className="footer-button" onClick={requestClear}>
              {S.clear}
            </button>
            <button type="button" className="download-all" disabled={done.length === 0} onClick={downloadAll}>
              {S.downloadAll}
            </button>
          </div>
        </>
      )}
    </footer>
  );
}
