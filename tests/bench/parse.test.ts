import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = () => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', 'parse.mjs')).href);

const lines = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const toolUse = (id: string, name: string, input: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (extra: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 4,
  duration_ms: 900,
  total_cost_usd: 0.25,
  result: 'ANSWER: 5',
  usage: { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 },
  ...extra,
});

describe('parseStream', () => {
  it('counts tool calls once per id and finds the result', async () => {
    const { parseStream, summarizeResult } = await load();
    const parsed = parseStream(lines([toolUse('a', 'Read'), toolUse('a', 'Read'), toolUse('b', 'Bash'), result()]));
    expect(parsed.toolCalls).toEqual({ Read: 1, Bash: 1 });
    expect(summarizeResult(parsed)).toEqual({
      isError: false,
      subtype: 'success',
      text: 'ANSWER: 5',
      numTurns: 4,
      costUsd: 0.25,
      durationMs: 900,
      usage: { input: 3, output: 7, cacheCreation: 100, cacheRead: 2000 },
    });
  });

  it('detects distill through tool names, skills and hook output', async () => {
    const { parseStream } = await load();
    expect(parseStream(lines([toolUse('a', 'mcp__plugin_distill_distill__convert'), result()])).distillUsed).toBe(true);
    expect(parseStream(lines([toolUse('a', 'Skill', { skill: 'distill:distill-office-documents' }), result()])).distillUsed).toBe(true);
    const hook = { type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Read', output: '{"updatedInput":{"file_path":"/x/cache/out/a.md"},"additionalContext":"[distill] tokens saved"}' };
    expect(parseStream(lines([hook, result()])).distillUsed).toBe(true);
  });

  it('ignores unrelated hooks and tools', async () => {
    const { parseStream } = await load();
    const hook = { type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Bash', output: '{"updatedInput":{"command":"rtk ls"}}' };
    expect(parseStream(lines([hook, toolUse('a', 'Read'), result()])).distillUsed).toBe(false);
  });

  it('survives malformed lines and a missing result', async () => {
    const { parseStream, summarizeResult } = await load();
    const parsed = parseStream('garbage\n{"type":\n[1]\n');
    expect(parsed.malformed).toBe(3);
    expect(summarizeResult(parsed)).toBeNull();
  });

  it('flags error results', async () => {
    const { parseStream, summarizeResult } = await load();
    expect(summarizeResult(parseStream(lines([result({ is_error: true })])))?.isError).toBe(true);
    expect(summarizeResult(parseStream(lines([result({ subtype: 'error_max_turns' })])))?.isError).toBe(true);
  });
});
