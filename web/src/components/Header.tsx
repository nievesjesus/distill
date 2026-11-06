import { useRef, useState } from 'react';
import { S } from '../strings';
import { ConnectPanel } from './ConnectPanel';

export type ViewMode = 'compact' | 'detailed';

interface HeaderProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}

const GITHUB_URL = 'https://github.com/nievesjesus/distill';

export function Header({ mode, onModeChange }: HeaderProps) {
  const [connectOpen, setConnectOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const closeConnect = () => {
    setConnectOpen(false);
    trigger.current?.focus();
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3c3.6 4.3 6.2 7.6 6.2 10.8a6.2 6.2 0 0 1-12.4 0C5.8 10.6 8.4 7.3 12 3z" />
            <path d="M9.5 15h5" />
          </svg>
        </span>
        <span className="brand-name">{S.brand}</span>
      </div>
      <div className="header-tools">
        <div className="segmented">
          <button type="button" aria-pressed={mode === 'compact'} onClick={() => onModeChange('compact')}>
            {S.compact}
          </button>
          <button type="button" aria-pressed={mode === 'detailed'} onClick={() => onModeChange('detailed')}>
            {S.detailed}
          </button>
        </div>
        <button ref={trigger} type="button" className="icon-link" aria-haspopup="dialog" aria-label={S.connect} onClick={() => setConnectOpen(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 7H6a3 3 0 0 0 0 6h3" />
            <path d="M15 7h3a3 3 0 0 1 0 6h-3" />
            <path d="M8 10h8" />
          </svg>
        </button>
        <a className="icon-link" href={GITHUB_URL} aria-label={S.github} target="_blank" rel="noreferrer">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 19c-4 1.3-4-2-6-2.5" />
            <path d="M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.2 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
          </svg>
        </a>
      </div>
      <ConnectPanel open={connectOpen} onClose={closeConnect} />
    </header>
  );
}
