import { bootstrapMedianCI, iqr, median } from './stats.mjs';

export function totalInputTokens(record) {
  const u = record.usage ?? {};
  return (u.input ?? 0) + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0);
}

export function finalRecords(records) {
  const latest = new Map();
  for (const r of records) {
    const key = [r.night, r.task, r.arm, r.repeat, r.model].join('|');
    const prior = latest.get(key);
    if (prior === undefined || (r.attempt ?? 1) >= (prior.attempt ?? 1)) latest.set(key, r);
  }
  return [...latest.values()];
}

function spread(values) {
  const range = iqr(values);
  return { median: median(values), q1: range?.[0] ?? null, q3: range?.[1] ?? null };
}

export function summarizeArm(records) {
  const ok = records.filter((r) => r.ok === true);
  const correct = ok.filter((r) => r.correct === true).length;
  return {
    runs: records.length,
    failures: records.length - ok.length,
    failureRate: records.length === 0 ? null : (records.length - ok.length) / records.length,
    answered: ok.filter((r) => r.correct !== null && r.correct !== undefined).length,
    correct,
    accuracy: ok.length === 0 ? null : correct / ok.length,
    cost: spread(ok.map((r) => r.costUsd)),
    inputTokens: spread(ok.map(totalInputTokens)),
    turns: spread(ok.filter((r) => typeof r.numTurns === 'number').map((r) => r.numTurns)),
    durationMs: spread(ok.map((r) => r.durationMs)),
    distillUsedRate: ok.length === 0 ? null : ok.filter((r) => r.distillUsed === true).length / ok.length,
    spentUsd: records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
  };
}

function ratio(a, b) {
  return b > 0 ? a / b : null;
}

export function pairByTask(records, tasksById) {
  const byTask = new Map();
  for (const r of records) {
    if (!byTask.has(r.task)) byTask.set(r.task, { baseline: [], distill: [] });
    byTask.get(r.task)[r.arm]?.push(r);
  }
  const pairs = [];
  for (const [task, arms] of byTask) {
    const okBase = arms.baseline.filter((r) => r.ok === true);
    const okDistill = arms.distill.filter((r) => r.ok === true);
    if (okBase.length === 0 || okDistill.length === 0) continue;
    const baseCost = median(okBase.map((r) => r.costUsd));
    const distillCost = median(okDistill.map((r) => r.costUsd));
    const baseTokens = median(okBase.map(totalInputTokens));
    const distillTokens = median(okDistill.map(totalInputTokens));
    const accuracy = (list) => list.filter((r) => r.correct === true).length / list.length;
    const meta = tasksById.get(task);
    pairs.push({
      task,
      doc: meta?.doc ?? okBase[0].doc,
      tags: meta?.tags ?? [],
      baselineRuns: okBase.length,
      distillRuns: okDistill.length,
      baselineCost: baseCost,
      distillCost,
      costRatio: ratio(distillCost, baseCost),
      baselineTokens: baseTokens,
      distillTokens,
      tokenRatio: ratio(distillTokens, baseTokens),
      baselineAccuracy: accuracy(okBase),
      distillAccuracy: accuracy(okDistill),
      distillUsedRate: okDistill.filter((r) => r.distillUsed === true).length / okDistill.length,
    });
  }
  return pairs.sort((a, b) => a.task.localeCompare(b.task));
}

function ratioSummary(pairs, field, seed) {
  const values = pairs.map((p) => p[field]).filter((v) => typeof v === 'number');
  if (values.length === 0) return { tasks: 0, median: null, ci95: null };
  return { tasks: values.length, median: median(values), ci95: bootstrapMedianCI(values, { seed, resamples: 2000 }) };
}

export function lostTasks(pairs) {
  const lost = [];
  for (const p of pairs) {
    const reasons = [];
    if (p.costRatio !== null && p.costRatio > 1) reasons.push('cost more');
    if (p.distillAccuracy < p.baselineAccuracy) reasons.push('less accurate');
    if (reasons.length > 0) lost.push({ ...p, reasons });
  }
  return lost.sort((a, b) => (b.costRatio ?? 0) - (a.costRatio ?? 0));
}

export function aggregate(records, tasks = []) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const finals = finalRecords(records);
  const nights = [...new Set(finals.map((r) => r.night))].sort();
  const models = [...new Set(finals.map((r) => r.model))].sort();
  const packages = [...new Set(finals.filter((r) => r.arm === 'distill').map((r) => r.package).filter(Boolean))].sort();
  const baseline = finals.filter((r) => r.arm === 'baseline');
  const distill = finals.filter((r) => r.arm === 'distill');
  const pairs = pairByTask(finals, tasksById);
  const tags = [...new Set(pairs.flatMap((p) => p.tags))].sort();
  const byTag = tags.map((tag) => {
    const inTag = pairs.filter((p) => p.tags.includes(tag));
    const tagTasks = new Set(inTag.map((p) => p.task));
    const armOf = (list) => summarizeArm(list.filter((r) => tagTasks.has(r.task)));
    return {
      tag,
      tasks: inTag.length,
      cost: ratioSummary(inTag, 'costRatio', `tag-${tag}-cost`),
      tokens: ratioSummary(inTag, 'tokenRatio', `tag-${tag}-tokens`),
      baseline: armOf(baseline),
      distill: armOf(distill),
    };
  });
  return {
    header: {
      firstNight: nights[0] ?? null,
      lastNight: nights[nights.length - 1] ?? null,
      nights: nights.length,
      models,
      packages,
      runs: finals.length,
      spentUsd: records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    },
    arms: { baseline: summarizeArm(baseline), distill: summarizeArm(distill) },
    overall: {
      pairedTasks: pairs.length,
      cost: ratioSummary(pairs, 'costRatio', 'overall-cost'),
      tokens: ratioSummary(pairs, 'tokenRatio', 'overall-tokens'),
    },
    byTag,
    pairs,
    lost: lostTasks(pairs),
  };
}
