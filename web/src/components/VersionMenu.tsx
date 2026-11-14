import { useEffect, useRef, useState } from 'react';
import type { UpdateInfo } from '@core/types';
import type { UpdateState } from '../state/update';
import { S } from '../strings';

interface VersionMenuProps {
  info: UpdateInfo;
  update: UpdateState;
}

export function VersionMenu({ info, update }: VersionMenuProps) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const envOff = info.disabledBy === 'env';

  const checkNow = async () => {
    setChecking(true);
    await update.checkNow();
    setChecking(false);
  };

  return (
    <div className="version-menu" ref={root}>
      <button ref={trigger} type="button" className="version-btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {S.versionLabel(info.current)}
      </button>
      {open ? (
        <div className="version-pop" role="group" aria-label={S.updateMenuLabel}>
          <label className="version-row">
            <input type="checkbox" checked={info.enabled} disabled={envOff} onChange={(event) => update.setEnabled(event.target.checked)} />
            <span>{S.updateDaily}</span>
          </label>
          {envOff ? <p className="version-hint">{S.updateEnvOff}</p> : null}
          <button type="button" className="update-btn" disabled={checking} onClick={checkNow}>
            {checking ? S.updateChecking : S.updateCheckNow}
          </button>
          {info.latest && !info.available ? <p className="version-hint">{S.updateUpToDate}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
