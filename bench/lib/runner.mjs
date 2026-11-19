import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PDF_TOOLS, classifyPaths } from './classify.mjs';
import { gradeReply } from './grade.mjs';
import { parseStream, summarizeResult } from './parse.mjs';
import { docFileName } from './tasks.mjs';

const OUTPUT_CAP = 128 * 1024 * 1024;

export function buildPrompt(docName, question) {
  return `Answer this question about the file ${docName} in this folder: ${question} Finish your reply with one line: ANSWER: <answer>.`;
}

export function buildArgs({ prompt, model, arm, pluginDir, maxTurns, runBudgetUsd }) {
  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--allowedTools',
    'Read,Grep,Glob,Bash',
    '--max-budget-usd',
    String(runBudgetUsd),
  ];
  if (arm === 'distill') args.push('--plugin-dir', pluginDir);
  return args;
}

export function writeShims(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of PDF_TOOLS) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name}: command not found" >&2\nexit 127\n`);
    chmodSync(file, 0o755);
  }
}

export function buildEnv({ baseEnv, arm, packageSpec, cacheDir, scenario = 'dev', shimDir }) {
  const env = { ...baseEnv };
  if (scenario === 'clean' && shimDir) env.PATH = `${shimDir}${delimiter}${baseEnv.PATH ?? ''}`;
  delete env.DISTILL_PLUGIN_PACKAGE;
  delete env.DISTILL_CACHE_DIR;
  env.DISTILL_CACHE_DIR = cacheDir;
  if (arm === 'distill') env.DISTILL_PLUGIN_PACKAGE = packageSpec;
  return env;
}

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function execute(claude, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claude, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let done = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child, 'SIGKILL');
      resolve({ stdout, stderr, code, timedOut, spawnError });
    };
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export async function runOnce(spec, options) {
  const { task, doc, docPath, arm, repeat, attempt, scenario = 'dev' } = spec;
  const { claude, model, night, packageSpec, pluginDir, maxTurns, runBudgetUsd, timeoutMs, baseEnv, keep } = options;
  const root = mkdtempSync(join(tmpdir(), 'distill-bench-run-'));
  const project = join(root, 'project');
  const cacheDir = join(root, 'cache');
  mkdirSync(project);
  mkdirSync(cacheDir);
  const shimDir = join(root, 'shims');
  if (scenario === 'clean') writeShims(shimDir);
  const docName = docFileName(doc);
  copyFileSync(docPath, join(project, docName));
  const prompt = buildPrompt(docName, task.question);
  const args = buildArgs({ prompt, model, arm, pluginDir, maxTurns, runBudgetUsd });
  const env = buildEnv({ baseEnv, arm, packageSpec, cacheDir, scenario, shimDir });
  const started = Date.now();
  let outcome;
  try {
    outcome = await execute(claude, args, { cwd: project, env, timeoutMs });
  } finally {
    if (keep !== true) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const wall = Date.now() - started;
  const parsed = parseStream(outcome.stdout);
  const summary = summarizeResult(parsed);
  let error;
  if (outcome.spawnError) error = `spawn failed: ${outcome.spawnError}`;
  else if (outcome.timedOut) error = `timed out after ${timeoutMs} ms`;
  else if (outcome.code !== 0) error = `exit code ${outcome.code}`;
  else if (summary === null) error = 'no result event in output';
  else if (summary.isError) error = `claude reported ${summary.subtype ?? 'error'}`;
  const ok = error === undefined;
  const text = summary?.text ?? parsed.lastText;
  const graded = ok ? gradeReply(text, task.expected) : { answer: null, correct: null };
  const record = {
    night,
    ts: new Date().toISOString(),
    task: task.id,
    doc: task.doc,
    arm,
    scenario,
    model,
    package: arm === 'distill' ? packageSpec : null,
    repeat,
    attempt,
    ok,
    timedOut: outcome.timedOut,
    durationMs: summary?.durationMs ?? wall,
    numTurns: summary?.numTurns ?? null,
    costUsd: summary?.costUsd ?? 0,
    usage: summary?.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    toolCalls: parsed.toolCalls,
    distillUsed: parsed.distillUsed,
    paths: classifyPaths(parsed),
    answer: graded.answer,
    correct: graded.correct,
  };
  if (!ok) {
    record.error = error;
    const tail = outcome.stderr.trim().split('\n').slice(-3).join(' | ');
    if (tail !== '') record.stderrTail = tail.slice(0, 500);
  }
  return record;
}

export async function runWithRetry(spec, options, onRecord) {
  const first = await runOnce({ ...spec, attempt: 1 }, options);
  onRecord(first);
  if (first.ok) return first;
  const second = await runOnce({ ...spec, attempt: 2 }, options);
  onRecord(second);
  return second;
}
