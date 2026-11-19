#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_CFG, 'utf8'));
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const arm = argv.includes('--plugin-dir') ? 'distill' : 'baseline';
const file = /file (\S+) in this folder/.exec(prompt)?.[1] ?? 'unknown';
const key = `${file}|${arm}`;

appendFileSync(
  cfg.log,
  `${JSON.stringify({
    key,
    argv,
    cwd: process.cwd(),
    files: readdirSync(process.cwd()),
    cacheDir: process.env.DISTILL_CACHE_DIR ?? null,
    pluginPackage: process.env.DISTILL_PLUGIN_PACKAGE ?? null,
    pid: process.pid,
  })}\n`,
);

const counterFile = `${cfg.counter}.${key.replace(/[^a-z0-9]/gi, '_')}`;
const count = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) + 1 : 1;
writeFileSync(counterFile, String(count));

const plan = cfg.behaviors[key] ?? cfg.behaviors.default ?? [{ kind: 'ok', answer: '1' }];
const behavior = plan[Math.min(count, plan.length) - 1];

function result(extra) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    duration_ms: 1234,
    total_cost_usd: behavior.cost ?? 0.1,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 },
    ...extra,
  };
}

if (behavior.kind === 'hang') {
  setInterval(() => {}, 1000);
} else if (behavior.kind === 'exit') {
  process.stderr.write('boom\n');
  process.exit(behavior.code ?? 1);
} else if (behavior.kind === 'garbage') {
  process.stdout.write('not json at all\n{"type":\n');
} else {
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
  ];
  if (behavior.distill) lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__plugin_distill_distill__convert', input: {} }] } });
  if (behavior.kind === 'error') lines.push(result({ is_error: true, subtype: 'error_max_turns', result: '' }));
  else lines.push(result({ result: behavior.kind === 'noanswer' ? 'I could not tell.' : `Looked it up.\nANSWER: ${behavior.answer}` }));
  process.stdout.write(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
