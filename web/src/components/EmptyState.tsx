import { isDesktopShell } from '../lib/shell';
import { S } from '../strings';

interface EmptyStateProps {
  dragging: boolean;
  onBrowse: () => void;
}

const KINDS = ['PDF', 'DOCX', 'PPTX', 'XLSX', 'IMG'] as const;

function Illustration() {
  return (
    <svg className="empty-art" width="56" height="56" viewBox="0 0 56 56" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 8h16l7 7v22" />
      <path d="M17 8a3 3 0 0 0-3 3v3" />
      <rect x="8" y="14" width="26" height="32" rx="3" />
      <path d="M14 24h14M14 30h14M14 36h8" />
      <path className="empty-art-drop" d="M41 28C41 28 35 35 35 40a6 6 0 0 0 12 0C47 35 41 28 41 28Z" />
    </svg>
  );
}

export function EmptyState({ dragging, onBrowse }: EmptyStateProps) {
  return (
    <section className="empty-state" data-dragging={dragging} aria-labelledby="empty-title">
      <Illustration />
      <h2 id="empty-title" className="empty-title">
        {S.emptyTitle}
      </h2>
      <p className="empty-hint">{isDesktopShell() ? S.emptyHintDesktop : S.emptyHint}</p>
      <ul className="empty-kinds" aria-hidden="true">
        {KINDS.map((kind) => (
          <li key={kind} className={`kind kind-${kind.toLowerCase()}`}>
            {kind}
          </li>
        ))}
      </ul>
      <button type="button" className="empty-browse" onClick={onBrowse}>
        {S.browseFiles}
      </button>
    </section>
  );
}
