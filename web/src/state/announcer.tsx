import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Announce = (text: string) => void;

const REANNOUNCE_DELAY_MS = 50;

const AnnouncerContext = createContext<Announce>(() => undefined);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const announce = useCallback<Announce>((next) => {
    if (timer.current) clearTimeout(timer.current);
    setText('');
    timer.current = setTimeout(() => setText(next), REANNOUNCE_DELAY_MS);
  }, []);

  const value = useMemo(() => announce, [announce]);

  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      <div role="status" className="visually-hidden">
        {text}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}
