import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { acquireLock } from './lib/lock.mjs';
import { buildPlan, budgetReached, finishedKeys, limitPaired, nightCost, unitKey } from './lib/plan.mjs';
import { corpusDir, demoDir, repoRoot, resultsDir } from './lib/paths.mjs';
import { runWithRetry } from './lib/runner.mjs';
import { docFileName, loadCorpus, loadTasks, selectTasks, validate } from './lib/tasks.mjs';

function localNight() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readRecords(file) {
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

function resolveDocPath(doc, env, regenerated) {
  if (typeof doc.local === 'string') {
    const file = join(demoDir(env), doc.local.slice('demo:'.length));
    if (!existsSync(file) && !regenerated.done) {
      regenerated.done = true;
      console.log('Demo documents missing, generating them with scripts/marketing/make-demo-docs.mjs');
      spawnSync(process.execPath, [join(repoRoot, 'scripts', 'marketing', 'make-demo-docs.mjs')], { cwd: repoRoot, stdio: 'inherit' });
    }
    return existsSync(file) ? file : null;
  }
  const file = join(corpusDir(env), docFileName(doc));
  return existsSync(file) ? file : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const corpus = loadCorpus(args['corpus-file'] || undefined);
  const allTasks = loadTasks(args['tasks-file'] || undefined);
  const problems = validate(corpus, allTasks);
  if (problems.length > 0) throw new Error(`Invalid corpus or tasks:\n${problems.join('\n')}`);
  const tasks = selectTasks(allTasks, args.tasks);
  if (tasks.length === 0) throw new Error(`No tasks match "${args.tasks}"`);
  const docs = new Map(corpus.map((doc) => [doc.id, doc]));
  const night = args.night || localNight();
  const seed = args.seed || night;
  const results = args.results || resultsDir(env);
  mkdirSync(results, { recursive: true });
  const runsFile = join(results, 'runs.jsonl');
  const claude = args.claude || env.DISTILL_BENCH_CLAUDE || 'claude';

  const scenarios = args.scenario === 'both' ? ['dev', 'clean'] : [args.scenario];
  let plan = buildPlan({ tasks, arms: args.arms, repeats: args.repeats, seed, scenarios });
  const pairUp = (units) => (args.paired ? limitPaired(units, args['max-runs']) : units);
  if (args['dry-run']) {
    plan = pairUp(plan);
    for (const unit of plan) console.log(`${unit.task.id} ${unit.arm} ${unit.scenario} #${unit.repeat}`);
    console.log(`${plan.length} runs planned for ${night}`);
    return;
  }

  const release = acquireLock(join(results, '.lock'));
  if (release === null) throw new Error('Another benchmark runner holds the lock.');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }

  try {
    const existing = readRecords(runsFile);
    if (args.resume) {
      const done = finishedKeys(existing);
      const before = plan.length;
      plan = plan.filter((unit) => !done.has(unitKey(night, unit.task.id, unit.arm, unit.repeat, args.model, unit.scenario)));
      console.log(`Resume: ${before - plan.length} of ${before} runs already done for ${night}`);
    }
    plan = pairUp(plan);
    const spent = Object.fromEntries(scenarios.map((scenario) => [scenario, nightCost(existing, night, scenario)]));
    const limit = args['max-cost-usd'] / scenarios.length;
    const exhausted = new Set();
    const spentLabel = () => (scenarios.length === 1 ? `$${spent[scenarios[0]].toFixed(2)}` : scenarios.map((scenario) => `$${spent[scenario].toFixed(2)} ${scenario}`).join(', '));
    const regenerated = { done: false };
    const pluginDir = join(repoRoot, 'plugins', 'distill');
    const options = {
      claude,
      model: args.model,
      night,
      packageSpec: args.package,
      pluginDir,
      maxTurns: args['max-turns'],
      runBudgetUsd: args['run-budget-usd'],
      timeoutMs: args['timeout-ms'],
      baseEnv: env,
      keep: args.keep,
    };
    let started = 0;
    let failures = 0;
    for (const unit of plan) {
      if (started >= args['max-runs']) {
        console.log(`Stopping: reached --max-runs ${args['max-runs']}`);
        break;
      }
      if (budgetReached(spent[unit.scenario], limit)) {
        exhausted.add(unit.scenario);
        if (exhausted.size === scenarios.length) {
          console.log(`Stopping: spent ${spentLabel()} of the $${args['max-cost-usd']} budget for ${night}`);
          break;
        }
        continue;
      }
      const doc = docs.get(unit.task.doc);
      const docPath = resolveDocPath(doc, env, regenerated);
      if (docPath === null) {
        console.error(`Skipping ${unit.task.id}: document ${doc.id} is not available (run bench:fetch)`);
        continue;
      }
      started += 1;
      const final = await runWithRetry({ task: unit.task, doc, docPath, arm: unit.arm, repeat: unit.repeat, scenario: unit.scenario }, options, (record) => {
        appendFileSync(runsFile, `${JSON.stringify(record)}\n`);
        if (typeof record.costUsd === 'number') spent[unit.scenario] += record.costUsd;
      });
      if (!final.ok) failures += 1;
      const verdict = final.ok ? (final.correct === true ? 'correct' : final.correct === false ? 'wrong' : 'no answer') : `failed (${final.error})`;
      console.log(`[${started}/${plan.length}] ${unit.task.id} ${unit.arm} ${unit.scenario} #${unit.repeat}: ${verdict} $${final.costUsd.toFixed(3)}`);
    }
    console.log(`Done: ${started} runs, ${failures} failed, ${spentLabel()} spent tonight, results in ${runsFile}`);
  } finally {
    release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
