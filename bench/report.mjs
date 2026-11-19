import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { aggregate } from './lib/aggregate.mjs';
import { resultsDir } from './lib/paths.mjs';
import { renderReport } from './lib/render.mjs';
import { loadTasks } from './lib/tasks.mjs';

function parseReportArgs(argv) {
  const values = { results: '', since: '', out: '', model: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    const inline = arg.indexOf('=');
    const key = inline === -1 ? arg.slice(2) : arg.slice(2, inline);
    if (!arg.startsWith('--') || !(key in values)) throw new Error(`Unknown option ${arg}`);
    const value = inline === -1 ? argv[i + 1] : arg.slice(inline + 1);
    if (inline === -1) i += 1;
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    values[key] = value;
  }
  if (values.since !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) throw new Error('--since must be YYYY-MM-DD');
  return values;
}

export function readRuns(file) {
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}

function main() {
  const args = parseReportArgs(process.argv.slice(2));
  const results = args.results || resultsDir();
  const out = resolve(args.out || join(results, 'bench-report.md'));
  let records = readRuns(join(results, 'runs.jsonl'));
  if (args.since !== '') records = records.filter((r) => r.night >= args.since);
  if (args.model !== '') records = records.filter((r) => r.model === args.model);
  const data = aggregate(records, loadTasks());
  const markdown = renderReport(data, { since: args.since });
  writeFileSync(out, `${markdown}\n`);
  writeFileSync(join(dirname(out), 'report.json'), `${JSON.stringify(data, null, 2)}\n`);
  console.log(markdown);
  console.log(`\nWrote ${out} and ${join(dirname(out), 'report.json')}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
