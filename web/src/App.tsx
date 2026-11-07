import { useCallback, useEffect, useRef, useState } from 'react';
import { savedPercent } from '@core/format';
import { Dropzone, focusBrowse } from './components/Dropzone';
import { EmptyState } from './components/EmptyState';
import { FileList } from './components/FileList';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import type { ViewMode } from './components/Header';
import { OptimizeBar } from './components/OptimizeBar';
import { useExportTracking } from './lib/desktop-bridge';
import { AnnouncerProvider, useAnnounce } from './state/announcer';
import { useFiles } from './state/files';
import { useSettings } from './state/settings';
import { ERROR_MESSAGES, S } from './strings';

const [taglineStart, taglineAccent, taglineEnd] = S.tagline;

function AppBody() {
  const { settings, update, toggleBooster, toggleLingua } = useSettings();
  const { files, add, remove, clear, markExported, healthError, health, linguaFailed, retryLingua, installLingua } = useFiles(settings);
  const announce = useAnnounce();
  const pickerRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef(files);
  filesRef.current = files;

  const removeFile = useCallback(
    (localId: string) => {
      const file = filesRef.current.find((candidate) => candidate.localId === localId);
      const wasLast = filesRef.current.length === 1;
      remove(localId);
      if (file) announce(S.removed(file.name));
      if (file && wasLast) requestAnimationFrame(focusBrowse);
    },
    [remove, announce],
  );

  const clearAll = useCallback(() => {
    clear();
    announce(S.cleared);
    requestAnimationFrame(focusBrowse);
  }, [clear, announce]);

  const exportRows = useExportTracking(markExported);
  const exportRow = useCallback((localId: string, filename?: string) => exportRows([localId], filename), [exportRows]);
  const announced = useRef(new Map<string, 'done' | 'error'>());

  useEffect(() => {
    for (const file of files) {
      const seen = announced.current.get(file.localId);
      if (file.status === 'done' && file.outTokens !== undefined && file.rawTokens !== undefined && seen === undefined) {
        announced.current.set(file.localId, 'done');
        announce(S.announceReady(file.name, savedPercent(file.rawTokens, file.outTokens)));
      } else if (file.status === 'error' && file.error && seen !== 'error') {
        announced.current.set(file.localId, 'error');
        announce(`${file.name}: ${ERROR_MESSAGES[file.error.code]}`);
      }
    }
  }, [files, announce]);

  useEffect(() => {
    if (linguaFailed) announce(S.linguaFailed);
  }, [linguaFailed, announce]);

  const linguaState = health?.lingua?.state;
  const previousLinguaState = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousLinguaState.current;
    previousLinguaState.current = linguaState;
    if (linguaState === 'ready' && previous !== undefined && previous !== 'ready') announce(S.linguaReady);
    if (previous === 'installing' && (linguaState === 'idle' || linguaState === 'downloading') && health?.lingua?.installed) announce(S.linguaInstalled);
  }, [linguaState, announce]);

  const mode: ViewMode = settings.detailed ? 'detailed' : 'compact';

  return (
    <div className="page">
      <div className="column">
        <Header mode={mode} onModeChange={(next) => update({ detailed: next === 'detailed', optionsOpen: next === 'detailed' })} />
        <div className="body">
          <h1 className="tagline">
            {taglineStart}
            <em>{taglineAccent}</em>
            {taglineEnd}
          </h1>
          <Dropzone onFiles={add} inputRef={pickerRef} onDraggingChange={setDragging} />
          {healthError ? (
            <p className="app-error" role="alert">
              {healthError.message === S.unreachable ? S.unreachable : ERROR_MESSAGES[healthError.code]}
            </p>
          ) : null}
          <OptimizeBar
            settings={settings}
            onOptimizeChange={(optimize) => update({ optimize })}
            onOptionsOpenChange={(optionsOpen) => update({ optionsOpen })}
            onToggleBooster={toggleBooster}
            onToggleLingua={toggleLingua}
            health={health}
            linguaFailed={linguaFailed}
            onLinguaChange={(patch) => update({ lingua: { ...settings.lingua, ...patch } })}
            onRetryLingua={retryLingua}
            onInstallLingua={() => {
              update({ lingua: { ...settings.lingua, on: true } });
              installLingua();
            }}
          />
          {files.length === 0 ? (
            <EmptyState dragging={dragging} onBrowse={() => pickerRef.current?.click()} />
          ) : (
            <FileList files={files} detailed={settings.detailed} onRemove={removeFile} onExported={exportRow} />
          )}
          <Footer files={files} onClear={clearAll} onExported={exportRows} />
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AnnouncerProvider>
      <AppBody />
    </AnnouncerProvider>
  );
}
