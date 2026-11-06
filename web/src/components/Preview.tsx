import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { getJson } from '../api';
import { downloadText } from '../lib/download';
import { jsonName } from '../lib/names';
import { ERROR_MESSAGES, S } from '../strings';
import type { ErrorCode } from '@core/types';

interface PreviewProps {
  id: string;
  name: string;
  text: string;
  detailed: boolean;
  serverId?: string;
  rawTokens?: number;
  outTokens?: number;
}

type Tab = 'markdown' | 'json';

type JsonState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; code: ErrorCode };

const TABS: readonly Tab[] = ['markdown', 'json'];
const JSON_LIMIT = 2_000_000;
const JSON_TYPE = 'application/json;charset=utf-8';

const jsonResults = new Map<string, string>();
const jsonInflight = new Map<string, Promise<string>>();

export function clearJsonCache(): void {
  jsonResults.clear();
  jsonInflight.clear();
}

function loadJson(serverId: string): Promise<string> {
  const cached = jsonResults.get(serverId);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = jsonInflight.get(serverId);
  if (inflight) return inflight;
  const request = getJson(serverId).then(
    (value) => {
      const text = JSON.stringify(value, null, 2);
      jsonResults.set(serverId, text);
      jsonInflight.delete(serverId);
      return text;
    },
    (error: unknown) => {
      jsonInflight.delete(serverId);
      throw error;
    },
  );
  jsonInflight.set(serverId, request);
  return request;
}

function errorCode(error: unknown): ErrorCode {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code in ERROR_MESSAGES) return code as ErrorCode;
  }
  return 'parse_failed';
}

function useJsonText(serverId: string | undefined, active: boolean) {
  const [state, setState] = useState<JsonState>(() => {
    const cached = serverId === undefined ? undefined : jsonResults.get(serverId);
    return cached === undefined ? { status: 'idle' } : { status: 'ready', text: cached };
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active || serverId === undefined) return;
    const cached = jsonResults.get(serverId);
    if (cached !== undefined) {
      setState({ status: 'ready', text: cached });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    loadJson(serverId).then(
      (text) => {
        if (!cancelled) setState({ status: 'ready', text });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', code: errorCode(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, serverId, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { state, retry };
}

function SavingsLine({ rawTokens, outTokens }: { rawTokens?: number; outTokens?: number }) {
  const describedBy = useId();
  if (rawTokens === undefined || outTokens === undefined) return null;
  const width = rawTokens === 0 ? 100 : Math.max(2, Math.round((outTokens / rawTokens) * 100));
  return (
    <div className="savings">
      <span className="savings-bar" aria-hidden="true">
        <span className="savings-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="savings-detail" title={S.tokenCountTitle} aria-describedby={describedBy}>
        {S.tokenDetail(rawTokens.toLocaleString('en-US'), outTokens.toLocaleString('en-US'))}
      </span>
      <span id={describedBy} className="visually-hidden">
        {S.tokenCountTitle}
      </span>
    </div>
  );
}

export function Preview({ id, name, text, detailed, serverId, rawTokens, outTokens }: PreviewProps) {
  const [tab, setTab] = useState<Tab>('markdown');
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ markdown: null, json: null });
  const tabsId = useId();
  const activeTab: Tab = detailed ? tab : 'markdown';
  const { state, retry } = useJsonText(serverId, detailed && activeTab === 'json');

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    let next: Tab | null = null;
    if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length];
    if (event.key === 'ArrowLeft') next = TABS[(index + TABS.length - 1) % TABS.length];
    if (event.key === 'Home') next = TABS[0];
    if (event.key === 'End') next = TABS[TABS.length - 1];
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const labels: Record<Tab, string> = { markdown: S.tabMarkdown, json: S.tabJson };

  let body: string = text;
  let truncated = false;
  let jsonText = '';
  if (activeTab === 'json') {
    if (state.status === 'ready') {
      jsonText = state.text;
      truncated = jsonText.length > JSON_LIMIT;
      body = truncated ? `${jsonText.slice(0, JSON_LIMIT)}${S.jsonTruncated}` : jsonText;
    } else if (state.status === 'error') {
      body = ERROR_MESSAGES[state.code];
    } else {
      body = S.loadingJson;
    }
  }

  const label = activeTab === 'json' ? S.jsonPreviewLabel(name) : S.previewLabel(name);

  return (
    <div className="preview" data-detailed={detailed}>
      {detailed ? (
        <div className="preview-tools">
          <div className="segmented" role="tablist" aria-label={S.tabsLabel}>
            {TABS.map((entry) => (
              <button
                key={entry}
                ref={(node) => {
                  tabRefs.current[entry] = node;
                }}
                type="button"
                role="tab"
                id={`${tabsId}-${entry}`}
                aria-selected={activeTab === entry}
                aria-controls={id}
                tabIndex={activeTab === entry ? 0 : -1}
                onClick={() => setTab(entry)}
                onKeyDown={move}
              >
                {labels[entry]}
              </button>
            ))}
          </div>
          <SavingsLine rawTokens={rawTokens} outTokens={outTokens} />
        </div>
      ) : null}
      <div id={id} className="preview-text" role="region" tabIndex={0} aria-label={label}>
        <pre>{body}</pre>
      </div>
      {activeTab === 'json' && state.status === 'error' ? (
        <button type="button" className="text-button" onClick={retry}>
          {S.retry}
        </button>
      ) : null}
      {truncated ? (
        <button type="button" className="text-button" onClick={() => downloadText(jsonName(name), jsonText, JSON_TYPE)}>
          {S.downloadJson}
        </button>
      ) : null}
    </div>
  );
}
