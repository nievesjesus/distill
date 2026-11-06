import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, useSettings } from '../src/state/settings';

const KEY = 'distill:settings';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useSettings', () => {
  it('starts from the documented defaults', () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual({
      optimize: true,
      active: ['dedupe', 'media', 'tables', 'ws'],
      detailed: false,
      optionsOpen: false,
      lingua: { on: false, model: 'tinybert', rate: 0.6 },
    });
    expect(DEFAULT_SETTINGS.optimize).toBe(true);
  });

  it('survives a reload', () => {
    const first = renderHook(() => useSettings());
    act(() => first.result.current.update({ optimize: false, detailed: true }));
    act(() => first.result.current.toggleBooster('tables'));
    first.unmount();
    const second = renderHook(() => useSettings());
    expect(second.result.current.settings.optimize).toBe(false);
    expect(second.result.current.settings.detailed).toBe(true);
    expect(second.result.current.settings.active).toEqual(['dedupe', 'media', 'ws']);
  });

  it('ignores corrupt localStorage', () => {
    localStorage.setItem(KEY, '{not json');
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back per field for partial or mistyped JSON', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ optimize: false, active: ['ws', 'bogus', 7], detailed: 'yes', lingua: { on: true, model: 'nope', rate: 'fast' } }),
    );
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual({
      ...DEFAULT_SETTINGS,
      optimize: false,
      active: ['ws'],
      lingua: { on: true, model: 'tinybert', rate: 0.6 },
    });
  });

  it('survives storage that throws on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    act(() => result.current.update({ detailed: true }));
    expect(result.current.settings.detailed).toBe(true);
  });
});
