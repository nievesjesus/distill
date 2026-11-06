import { savedPercent, shortCount } from '@core/format';
import type { FileEntry } from '../state/files';
import { S } from '../strings';

interface FooterProps {
  files: FileEntry[];
}

export function Footer({ files }: FooterProps) {
  if (files.length === 0) return null;
  const done = files.filter((file) => file.status === 'done');
  const measured = done.filter((file) => file.rawTokens !== undefined && file.outTokens !== undefined);
  const raw = measured.reduce((sum, file) => sum + (file.rawTokens ?? 0), 0);
  const out = measured.reduce((sum, file) => sum + (file.outTokens ?? 0), 0);
  const saved = savedPercent(raw, out);

  return (
    <footer className="footer">
      <div className="footer-total">
        <span className="footer-pct">{saved > 0 ? `−${saved}%` : '0%'}</span>
        <span className="footer-line">{S.footerLine(shortCount(raw), shortCount(out), done.length, files.length)}</span>
      </div>
      <button type="button" className="download-all" disabled>
        {S.downloadAll}
      </button>
    </footer>
  );
}
