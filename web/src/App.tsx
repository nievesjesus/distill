import { useEffect, useRef } from 'react';
import { savedPercent } from '@core/format';
import { Dropzone } from './components/Dropzone';
import { FileList } from './components/FileList';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import type { ViewMode } from './components/Header';
import { OptimizeBar } from './components/OptimizeBar';
import { AnnouncerProvider, useAnnounce } from './state/announcer';
import { useFiles } from './state/files';
import { useSettings } from './state/settings';
import { ERROR_MESSAGES, S } from './strings';

const [taglineStart, taglineAccent, taglineEnd] = S.tagline;

function AppBody() {
  const { settings, update, toggleBooster, toggleLingua } = useSettings();
  const { files, add, healthError, health, linguaFailed, retryLingua } = useFiles(settings);
  const announce = useAnnounce();
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
  }, [linguaState, announce]);

  const mode: ViewMode = settings.detailed ? 'detailed' : 'compact';

  return (
    <div className="page">
      <div className="column">
        <Header mode={mode} onModeChange={(next) => update({ detailed: next === 'detailed', optionsOpen: next === 'detailed' })} />
        <h1 className="tagline">
          {taglineStart}
          <em>{taglineAccent}</em>
          {taglineEnd}
        </h1>
        <Dropzone onFiles={add} />
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
        />
        <FileList files={files} detailed={settings.detailed} />
        <Footer files={files} />
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
