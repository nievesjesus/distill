import { useId } from 'react';
import { BOOSTERS } from '@core/boosters/pipeline';
import type { LocalBoosterId } from '@core/types';
import type { Settings } from '../state/settings';
import { S } from '../strings';

interface OptimizeBarProps {
  settings: Settings;
  onOptimizeChange: (optimize: boolean) => void;
  onOptionsOpenChange: (open: boolean) => void;
  onToggleBooster: (id: LocalBoosterId) => void;
  onToggleLingua: () => void;
}

const LOCAL_IDS: ReadonlySet<string> = new Set(['dedupe', 'media', 'tables', 'ws']);

export function OptimizeBar({ settings, onOptimizeChange, onOptionsOpenChange, onToggleBooster, onToggleLingua }: OptimizeBarProps) {
  const listId = useId();
  const { optimize, optionsOpen, detailed, active, lingua } = settings;
  const count = active.length + (lingua.on ? 1 : 0);

  return (
    <div className="optimize">
      <div className="optimize-head">
        <button type="button" role="switch" aria-checked={optimize} className="master" onClick={() => onOptimizeChange(!optimize)}>
          <span className="track" data-on={optimize}>
            <span className="knob" />
          </span>
          {S.optimize}
        </button>
        <button
          type="button"
          className="summary"
          aria-expanded={optionsOpen}
          aria-controls={listId}
          onClick={() => onOptionsOpenChange(!optionsOpen)}
        >
          {optimize ? S.boosters(count) : S.off}
          <svg className="chevron" data-open={optionsOpen} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      <div id={listId} className="booster-list" data-dim={!optimize} hidden={!optionsOpen}>
        {BOOSTERS.map((booster) => {
          const isLingua = booster.id === 'lingua';
          const checked = isLingua ? lingua.on : active.includes(booster.id as LocalBoosterId);
          const onClick = () => {
            if (isLingua) onToggleLingua();
            else if (LOCAL_IDS.has(booster.id)) onToggleBooster(booster.id as LocalBoosterId);
          };
          return (
            <button key={booster.id} type="button" role="switch" aria-checked={checked} aria-label={booster.name} className="booster" onClick={onClick}>
              <span className="check" data-on={checked}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              </span>
              <span className="booster-name">
                {booster.name}
                {detailed ? <span className="booster-hint"> — {booster.hint}</span> : null}
              </span>
              <span className="booster-save" data-lossy={booster.lossy}>
                −{Math.round(booster.estimate * 100)}%
              </span>
            </button>
          );
        })}
        {lingua.on && optimize ? <p className="lossy-note">{S.lossyNote}</p> : null}
      </div>
    </div>
  );
}
