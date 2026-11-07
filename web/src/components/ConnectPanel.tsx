import { useEffect, useId, useRef, useState } from 'react';
import { CONNECT_CLIENTS } from '../connect';
import type { ConnectClient } from '../connect';
import { copyText } from '../lib/clipboard';
import { useAnnounce } from '../state/announcer';
import { S } from '../strings';

interface ConnectPanelProps {
  open: boolean;
  onClose: () => void;
}

const COPIED_MS = 1500;

function Section({ client }: { client: ConnectClient }) {
  const announce = useAnnounce();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    const ok = await copyText(client.snippet);
    if (!ok) {
      announce(S.copyFailed);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <section className="connect-section">
      <div className="connect-client">
        <h4>{client.name}</h4>
      </div>
      <p className="connect-copy">{client.copy}</p>
      {(
        <div className="connect-snippet">
          <code>{client.snippet}</code>
          <button type="button" className="icon-button" aria-label={copied ? S.copied : S.connectCopy(client.name)} onClick={copy}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
          </button>
        </div>
      )}
    </section>
  );
}

export function ConnectPanel({ open, onClose }: ConnectPanelProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.hasAttribute('open')) dialog.showModal();
    if (!open && dialog.hasAttribute('open')) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="connect"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="connect-body">
          <div className="connect-head">
            <h2 id={titleId} className="connect-title">
              {S.connect}
            </h2>
            <button type="button" className="icon-button" aria-label={S.close} onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <p className="connect-copy">{S.connectIntro}</p>
          <h3 className="connect-group">{S.connectMcp}</h3>
          {CONNECT_CLIENTS.filter((client) => client.group === 'mcp').map((client) => (
            <Section key={client.id} client={client} />
          ))}
          <h3 className="connect-group">{S.connectHooks}</h3>
          {CONNECT_CLIENTS.filter((client) => client.group === 'hooks').map((client) => (
            <Section key={client.id} client={client} />
          ))}
        </div>
      ) : null}
    </dialog>
  );
}
