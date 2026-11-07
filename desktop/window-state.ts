import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface WindowState extends Rect {
  maximized: boolean;
  fullScreen: boolean;
}

const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 40;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseSaved(saved: unknown): WindowState | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined;
  const record = saved as Record<string, unknown>;
  const { x, y, width, height } = record;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height, maximized: record.maximized === true, fullScreen: record.fullScreen === true };
}

function overlap(rect: Rect, area: Rect): Rect {
  const left = Math.max(rect.x, area.x);
  const top = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function fitInto(size: Size, position: { x: number; y: number } | undefined, area: Rect, mins: Size): Rect {
  const width = Math.max(mins.width, Math.min(size.width, area.width));
  const height = Math.max(mins.height, Math.min(size.height, area.height));
  const x = position ? clamp(position.x, area.x, area.x + area.width - width) : area.x + Math.round((area.width - width) / 2);
  const y = position ? clamp(position.y, area.y, area.y + area.height - height) : area.y + Math.round((area.height - height) / 2);
  return { x, y, width, height };
}

export function restoreBounds(saved: unknown, workAreas: Rect[], defaults: Size, mins: Size): WindowState {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: defaults.width, height: defaults.height };
  const state = parseSaved(saved);
  if (!state) return { ...fitInto(defaults, undefined, primary, mins), maximized: false, fullScreen: false };
  const host = workAreas.find((area) => {
    const shared = overlap(state, area);
    return shared.width >= MIN_VISIBLE_WIDTH && shared.height >= MIN_VISIBLE_HEIGHT;
  });
  const bounds = host
    ? fitInto(state, state, host, mins)
    : fitInto(state, undefined, primary, mins);
  return { ...bounds, maximized: state.maximized, fullScreen: state.fullScreen };
}

export function readSavedState(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeSavedState(file: string, state: WindowState): void {
  const temp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, file);
}
