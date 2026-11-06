import { useState } from 'react';
import { Dropzone } from './components/Dropzone';
import { Header } from './components/Header';
import type { ViewMode } from './components/Header';
import { S } from './strings';

const [taglineStart, taglineAccent, taglineEnd] = S.tagline;

const ignoreFiles = (): void => undefined;

export function App() {
  const [mode, setMode] = useState<ViewMode>('compact');

  return (
    <div className="page">
      <div className="column">
        <Header mode={mode} onModeChange={setMode} />
        <h1 className="tagline">
          {taglineStart}
          <em>{taglineAccent}</em>
          {taglineEnd}
        </h1>
        <Dropzone onFiles={ignoreFiles} />
      </div>
    </div>
  );
}
