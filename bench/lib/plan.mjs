import { createHash } from 'node:crypto';

export function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPlan({ tasks, arms, repeats, seed, scenarios = ['dev'] }) {
  const units = [];
  for (const scenario of scenarios) for (const task of tasks) for (const arm of arms) for (let repeat = 1; repeat <= repeats; repeat += 1) units.push({ task, arm, repeat, scenario });
  const random = seededRandom(seed);
  for (let i = units.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [units[i], units[j]] = [units[j], units[i]];
  }
  return units;
}

export function unitKey(night, taskId, arm, repeat, model, scenario = 'dev') {
  return [night, taskId, arm, repeat, model, scenario].join('|');
}

export function finishedKeys(records) {
  const keys = new Set();
  for (const r of records) {
    if (r.ok === true || (r.attempt ?? 1) >= 2) keys.add(unitKey(r.night, r.task, r.arm, r.repeat, r.model, r.scenario ?? 'dev'));
  }
  return keys;
}

export function nightCost(records, night, scenario) {
  let total = 0;
  for (const r of records) {
    if (r.night !== night || typeof r.costUsd !== 'number') continue;
    if (scenario !== undefined && (r.scenario ?? 'dev') !== scenario) continue;
    total += r.costUsd;
  }
  return total;
}

export function budgetReached(spent, limit) {
  return Number.isFinite(limit) && spent >= limit;
}
