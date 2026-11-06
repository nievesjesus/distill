import { useId } from 'react';
import { BOOSTERS } from '@core/boosters/pipeline';
import type { Health, LinguaModel, LocalBoosterId } from '@core/types';
import type { Settings } from '../state/settings';
import { S } from '../strings';

interface OptimizeBarProps {
  settings: Settings;
  onOptimizeChange: (optimize: boolean) => void;
  onOptionsOpenChange: (open: boolean) => void;
  onToggleBooster: (id: LocalBoosterId) => void;
  onToggleLingua: () => void;
  health?: Health | null;
  linguaFailed?: boolean;
  onLinguaChange?: (patch: Partial<Settings['lingua']>) => void;
  onRetryLingua?: () => void;
}

const MODEL_IDS: readonly LinguaModel[] = ['tinybert', 'mobilebert', 'xlm-roberta'];

const LOCAL_IDS: ReadonlySet<string> = new Set(['dedupe', 'media', 'tables', 'ws']);

export function OptimizeBar({
  settings,
  onOptimizeChange,
  onOptionsOpenChange,
  onToggleBooster,
  onToggleLingua,
  health = null,
  linguaFailed = false,
  onLinguaChange = () => undefined,
  onRetryLingua = () => undefined,
}: OptimizeBarProps) {
  const listId = useId();
  const hintId = useId();
  const modelId = useId();
  const rateId = useId();
  const linguaStatus = health?.lingua;
  const installed = linguaStatus?.installed === true;
  const { optimize, optionsOpen, detailed, active, lingua } = settings;
  const linguaStatus0 = health?.lingua;
  const linguaEffective = lingua.on && (linguaStatus0 === undefined || linguaStatus0.installed === true);
  const count = active.length + (linguaEffective ? 1 : 0);

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
          const checked = isLingua ? linguaEffective : active.includes(booster.id as LocalBoosterId);
          const unavailable = isLingua && linguaStatus !== undefined && !installed;
          const onClick = () => {
            if (isLingua) onToggleLingua();
            else if (LOCAL_IDS.has(booster.id)) onToggleBooster(booster.id as LocalBoosterId);
          };
          return (
            <button
              key={booster.id}
              type="button"
              role="switch"
              aria-checked={checked}
              aria-label={unavailable ? `${booster.name} (${S.linguaNotInstalled})` : booster.name}
              aria-describedby={unavailable ? hintId : undefined}
              disabled={unavailable}
              className="booster"
              onClick={onClick}
            >
              <span className="check" data-on={checked}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              </span>
              <span className="booster-name">
                {booster.name}
                {unavailable ? <span className="booster-hint"> · {S.linguaNotInstalled}</span> : null}
                {detailed ? <span className="booster-hint"> — {booster.hint}</span> : null}
              </span>
              <span className="booster-save" data-lossy={booster.lossy}>
                −{Math.round(booster.estimate * 100)}%
              </span>
            </button>
          );
        })}
        {!installed && linguaStatus !== undefined ? (
          <p id={hintId} className="lingua-line">
            {S.linguaInstallHint}
          </p>
        ) : null}
        {linguaEffective && optimize ? <p className="lossy-note">{S.lossyNote}</p> : null}
        {linguaEffective && optimize && linguaStatus?.state === 'downloading' ? (
          <div className="lingua-download">
            <p className="lingua-line">{S.linguaDownloading(Math.round(linguaStatus.progress * 100))}</p>
            <span className="lingua-bar" aria-hidden="true">
              <span className="lingua-bar-fill" style={{ width: `${Math.round(linguaStatus.progress * 100)}%` }} />
            </span>
          </div>
        ) : null}
        {linguaEffective && optimize && linguaStatus?.state === 'error' ? (
          <p className="lingua-line">
            {S.linguaDownloadFailed}{' '}
            <button type="button" className="text-button" onClick={onRetryLingua}>
              {S.retry}
            </button>
          </p>
        ) : null}
        {lingua.on && optimize && linguaFailed ? <p className="lingua-line">{S.linguaFailed}</p> : null}
        {detailed ? (
          <div className="lingua-controls">
            <div className="control">
              <label htmlFor={modelId}>{S.modelLabel}</label>
              <select id={modelId} value={lingua.model} onChange={(event) => onLinguaChange({ model: event.target.value as LinguaModel })}>
                {MODEL_IDS.map((id) => (
                  <option key={id} value={id}>
                    {S.models[id]}
                  </option>
                ))}
              </select>
            </div>
            <div className="control">
              <label htmlFor={rateId}>{S.rateLabel}</label>
              <input
                id={rateId}
                type="range"
                min={0.3}
                max={0.9}
                step={0.05}
                value={lingua.rate}
                aria-valuetext={S.keepRate(Math.round(lingua.rate * 100))}
                onChange={(event) => onLinguaChange({ rate: Number(event.target.value) })}
              />
              <span className="control-value">{S.keepRate(Math.round(lingua.rate * 100))}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
