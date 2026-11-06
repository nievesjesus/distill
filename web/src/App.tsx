import { Dropzone } from './components/Dropzone';
import { FileList } from './components/FileList';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import type { ViewMode } from './components/Header';
import { OptimizeBar } from './components/OptimizeBar';
import { useFiles } from './state/files';
import { useSettings } from './state/settings';
import { ERROR_MESSAGES, S } from './strings';

const [taglineStart, taglineAccent, taglineEnd] = S.tagline;

export function App() {
  const { settings, update, toggleBooster, toggleLingua } = useSettings();
  const { files, add, healthError } = useFiles(settings);
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
        />
        <FileList files={files} />
        <Footer files={files} />
      </div>
    </div>
  );
}
