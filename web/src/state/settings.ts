import { useCallback, useEffect, useState } from 'react';
import type { LinguaModel, LocalBoosterId } from '@core/types';
import { BOOSTER_ORDER } from '@core/boosters/pipeline';

export interface Settings {
  optimize: boolean;
  active: LocalBoosterId[];
  detailed: boolean;
  optionsOpen: boolean;
  lingua: { on: boolean; model: LinguaModel; rate: number };
}

export const STORAGE_KEY = 'distill:settings';

const LINGUA_MODELS: readonly LinguaModel[] = ['tinybert', 'mobilebert', 'xlm-roberta'];

export const DEFAULT_SETTINGS: Settings = {
  optimize: true,
  active: [...BOOSTER_ORDER],
  detailed: false,
  optionsOpen: false,
  lingua: { on: false, model: 'tinybert', rate: 0.6 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readActive(value: unknown): LocalBoosterId[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.active];
  return BOOSTER_ORDER.filter((id) => value.includes(id));
}

function readLingua(value: unknown): Settings['lingua'] {
  const fallback = DEFAULT_SETTINGS.lingua;
  if (!isRecord(value)) return { ...fallback };
  const model = LINGUA_MODELS.find((candidate) => candidate === value.model) ?? fallback.model;
  const rate = typeof value.rate === 'number' && value.rate > 0 && value.rate <= 1 ? value.rate : fallback.rate;
  return { on: readBoolean(value.on, fallback.on), model, rate };
}

export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS);
  return {
    optimize: readBoolean(value.optimize, DEFAULT_SETTINGS.optimize),
    active: readActive(value.active),
    detailed: readBoolean(value.detailed, DEFAULT_SETTINGS.detailed),
    optionsOpen: readBoolean(value.optionsOpen, DEFAULT_SETTINGS.optionsOpen),
    lingua: readLingua(value.lingua),
  };
}

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return parseSettings(stored === null ? null : JSON.parse(stored));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    return;
  }
}

export interface SettingsApi {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  toggleBooster: (id: LocalBoosterId) => void;
  toggleLingua: () => void;
}

export function useSettings(): SettingsApi {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const toggleBooster = useCallback((id: LocalBoosterId) => {
    setSettings((current) => {
      const next = current.active.includes(id) ? current.active.filter((entry) => entry !== id) : [...current.active, id];
      return { ...current, active: BOOSTER_ORDER.filter((entry) => next.includes(entry)) };
    });
  }, []);

  const toggleLingua = useCallback(() => {
    setSettings((current) => ({ ...current, lingua: { ...current.lingua, on: !current.lingua.on } }));
  }, []);

  return { settings, update, toggleBooster, toggleLingua };
}
