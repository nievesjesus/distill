const money = (v) => (v === null || v === undefined ? 'n/a' : `$${v.toFixed(3)}`);
const num = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-US'));
const dec = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(1));
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`);
const secs = (v) => (v === null || v === undefined ? 'n/a' : `${(v / 1000).toFixed(0)}s`);
const times = (v) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(2)}x`);
const range = (s, fmt) => (s.median === null ? 'n/a' : `${fmt(s.median)} (${fmt(s.q1)}-${fmt(s.q3)})`);
const ci = (summary) => (summary.median === null ? 'n/a' : `${times(summary.median)} (95% CI ${times(summary.ci95[0])} to ${times(summary.ci95[1])}, ${summary.tasks} tasks)`);
const change = (summary) => (summary.median === null ? 'n/a' : `${summary.median <= 1 ? '-' : '+'}${Math.abs((summary.median - 1) * 100).toFixed(1)}%`);

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

export function renderReport(data, options = {}) {
  const { header, arms, overall, byTag, lost } = data;
  const out = [];
  out.push('# distill benchmark report', '');
  if (header.runs === 0) {
    out.push('No runs found yet.', '');
    return out.join('\n');
  }
  out.push(`- Nights: ${header.nights} (${header.firstNight} to ${header.lastNight})`);
  out.push(`- Model: ${header.models.join(', ')}`);
  out.push(`- distill package: ${header.packages.length > 0 ? header.packages.join(', ') : 'none'}`);
  out.push(`- Runs: ${header.runs} final runs, $${header.spentUsd.toFixed(2)} spent including retries`);
  if (options.since) out.push(`- Since: ${options.since}`);
  out.push('');
  out.push('Both arms use the same prompt and flags in a fresh folder with a fresh distill cache. User-level Claude settings and plugins are shared by both arms. Costs are the totals reported by Claude Code, including cache reads and writes. Medians with the interquartile range in parentheses.', '');

  out.push('## Per arm', '');
  const armRow = (name, a) => [
    name,
    String(a.runs),
    `${pct(a.failureRate)} (${a.failures})`,
    pct(a.accuracy),
    range(a.cost, money),
    range(a.inputTokens, num),
    range(a.turns, dec),
    range(a.durationMs, secs),
    name === 'distill' ? pct(a.distillUsedRate) : 'n/a',
  ];
  out.push(table(['arm', 'runs', 'failures', 'accuracy', 'cost', 'input tokens', 'turns', 'duration', 'distill used'], [armRow('baseline', arms.baseline), armRow('distill', arms.distill)]), '');

  out.push('## Paired comparison (distill / baseline)', '');
  out.push(`- Cost: median ratio ${ci(overall.cost)}, a change of ${change(overall.cost)}`);
  out.push(`- Total input tokens: median ratio ${ci(overall.tokens)}, a change of ${change(overall.tokens)}`);
  out.push('');
  out.push('A ratio below 1.00x means distill was cheaper. The interval comes from a seeded bootstrap (2,000 resamples) over the per-task median ratios.', '');

  out.push('## By tag', '');
  out.push(
    table(
      ['tag', 'tasks', 'cost ratio', 'token ratio', 'accuracy baseline', 'accuracy distill'],
      byTag.map((t) => [t.tag, String(t.tasks), t.cost.median === null ? 'n/a' : times(t.cost.median), t.tokens.median === null ? 'n/a' : times(t.tokens.median), pct(t.baseline.accuracy), pct(t.distill.accuracy)]),
    ),
    '',
  );

  out.push('## Where distill lost', '');
  if (lost.length === 0) out.push('No task where distill cost more or was less accurate.', '');
  else {
    out.push(
      table(
        ['task', 'tags', 'cost ratio', 'baseline cost', 'distill cost', 'accuracy baseline', 'accuracy distill', 'distill used', 'why'],
        lost.map((p) => [p.task, p.tags.join(', '), times(p.costRatio), money(p.baselineCost), money(p.distillCost), pct(p.baselineAccuracy), pct(p.distillAccuracy), pct(p.distillUsedRate), p.reasons.join(', ')]),
      ),
      '',
    );
  }
  return out.join('\n');
}
