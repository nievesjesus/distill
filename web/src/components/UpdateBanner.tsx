import { useEffect, useRef, useState } from 'react';
import type { UpdateInfo } from '@core/types';
import { copyText } from '../lib/clipboard';
import type { UpdateState } from '../state/update';
import { S } from '../strings';

function commandFor(info: UpdateInfo): string | null {
  switch (info.method) {
    case 'npm-global':
      return `npm install -g distill-llm@${info.latest ?? 'latest'}`;
    case 'npx':
      return 'npx distill-llm@latest';
    case 'docker':
      return 'docker pull ghcr.io/nievesjesus/distill';
    case 'source':
      return 'git pull && npm ci && npm run build';
    default:
      return null;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button type="button" className="update-btn" onClick={copy}>
      {copied ? S.updateCopied : S.updateCopy}
    </button>
  );
}

export function UpdateBanner({ update }: { update: UpdateState }) {
  const { info, dismissed, dismiss, install } = update;
  if (!info || !info.enabled || info.method === 'desktop') return null;

  const state = info.install.state;
  const doneVersion = info.install.version ?? info.latest ?? '';
  const showDone = state === 'done' && dismissed !== doneVersion;
  const showOffer = info.available && info.latest !== null && dismissed !== info.latest;
  if (!showDone && !showOffer) return null;

  const dismissTarget = showDone ? doneVersion : (info.latest as string);
  const command = commandFor(info);

  let body;
  if (showDone) {
    body = <span className="update-text">{S.updateDone(doneVersion)}</span>;
  } else if (state === 'failed') {
    body = (
      <>
        <span className="update-text">{info.install.error ?? S.updateFailed}</span>
        <button type="button" className="update-btn" onClick={install}>
          {S.updateRetry}
        </button>
      </>
    );
  } else if (info.canInstall) {
    body = (
      <>
        <span className="update-text">{S.updateAvailable(info.latest as string, info.current)}</span>
        <button type="button" className="update-btn update-btn-primary" disabled={state === 'running'} onClick={install}>
          {state === 'running' ? S.updateRunning : S.updateAction}
        </button>
      </>
    );
  } else {
    body = (
      <>
        <span className="update-text">{S.updateAvailable(info.latest as string, info.current)}</span>
        {command ? (
          <>
            <code className="update-command" aria-label={S.updateCommandLabel}>
              {command}
            </code>
            <CopyButton text={command} />
          </>
        ) : null}
      </>
    );
  }

  return (
    <div className="update-banner" role="status">
      {body}
      <button type="button" className="update-dismiss" aria-label={S.updateDismiss} onClick={() => dismiss(dismissTarget)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
