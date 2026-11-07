import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSavedState, restoreBounds, writeSavedState } from '../../desktop/window-state';

const primary = { x: 0, y: 0, width: 1440, height: 900 };
const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };
const defaults = { width: 640, height: 780 };
const mins = { width: 440, height: 520 };

function restore(saved: unknown, areas = [primary]) {
  return restoreBounds(saved, areas, defaults, mins);
}

describe('restoreBounds', () => {
  it.each([undefined, null, 'oops', 42, {}, { x: 'a', y: 0, width: 600, height: 700 }, { x: 0, y: 0, width: 0, height: 700 }])(
    'falls back to centered defaults for %j',
    (saved) => {
      expect(restore(saved)).toEqual({ x: 400, y: 60, width: 640, height: 780, maximized: false, fullScreen: false });
    },
  );

  it('keeps a saved rectangle that is on screen', () => {
    const saved = { x: 100, y: 80, width: 700, height: 800, maximized: false, fullScreen: false };
    expect(restore(saved)).toEqual(saved);
  });

  it('recenters on the primary display when the saved display is gone', () => {
    const saved = { x: 2000, y: 100, width: 700, height: 800 };
    expect(restore(saved)).toEqual({ x: 370, y: 50, width: 700, height: 800, maximized: false, fullScreen: false });
  });

  it('keeps a rectangle that sits on a secondary display', () => {
    const saved = { x: 1600, y: 100, width: 700, height: 800 };
    expect(restore(saved, [primary, secondary])).toMatchObject({ x: 1600, y: 100, width: 700, height: 800 });
  });

  it('treats a sliver that barely overlaps a display as off screen', () => {
    const saved = { x: 1420, y: 100, width: 700, height: 800 };
    expect(restore(saved)).toMatchObject({ x: 370, y: 50 });
  });

  it('clips the size to the work area', () => {
    const saved = { x: -200, y: -50, width: 3000, height: 2000 };
    expect(restore(saved)).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('pulls a partly off-screen rectangle back inside', () => {
    const saved = { x: 1200, y: 700, width: 700, height: 800 };
    expect(restore(saved)).toMatchObject({ x: 740, y: 100, width: 700, height: 800 });
  });

  it('never goes below the minimums', () => {
    const saved = { x: 100, y: 100, width: 200, height: 100 };
    expect(restore(saved)).toMatchObject({ width: 440, height: 520 });
  });

  it('carries the maximized and full screen flags', () => {
    const saved = { x: 100, y: 100, width: 700, height: 800, maximized: true, fullScreen: true };
    expect(restore(saved)).toMatchObject({ maximized: true, fullScreen: true });
  });

  it('ignores non-boolean flags', () => {
    const saved = { x: 100, y: 100, width: 700, height: 800, maximized: 'yes', fullScreen: 1 };
    expect(restore(saved)).toMatchObject({ maximized: false, fullScreen: false });
  });
});

describe('saved state file', () => {
  it('writes atomically and reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-state-'));
    try {
      const file = join(dir, 'nested', 'window-state.json');
      const state = { x: 1, y: 2, width: 600, height: 700, maximized: false, fullScreen: false };
      writeSavedState(file, state);
      expect(readSavedState(file)).toEqual(state);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state);
      expect(readdirSync(join(dir, 'nested'))).toEqual(['window-state.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads missing or corrupt files as undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-state-'));
    try {
      expect(readSavedState(join(dir, 'absent.json'))).toBeUndefined();
      writeSavedState(join(dir, 'ok.json'), { x: 0, y: 0, width: 1, height: 1, maximized: false, fullScreen: false });
      expect(readSavedState(join(dir, 'ok.json'))).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
