const DISTILL = /distill/i;

export function parseStream(raw) {
  let result = null;
  let lastText = '';
  let malformed = 0;
  let distillUsed = false;
  const toolCalls = {};
  const toolUses = [];
  let converted = false;
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      malformed += 1;
      continue;
    }
    if (event.type === 'result') {
      result = event;
      continue;
    }
    if (event.type === 'system' && event.subtype === 'hook_response' && typeof event.hook_name === 'string' && event.hook_name.startsWith('PreToolUse')) {
      const output = `${event.output ?? ''}${event.stdout ?? ''}`;
      if (DISTILL.test(output)) distillUsed = true;
      if (output.includes('distill converted')) converted = true;
      continue;
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') lastText = block.text;
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          if (typeof block.id === 'string') {
            if (seen.has(block.id)) continue;
            seen.add(block.id);
          }
          toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
          toolUses.push({ name: block.name, input: block.input ?? {} });
          if (DISTILL.test(block.name)) distillUsed = true;
          if (block.name === 'Skill' && DISTILL.test(JSON.stringify(block.input ?? {}))) distillUsed = true;
        }
      }
      continue;
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        const content = typeof block?.content === 'string' ? block.content : Array.isArray(block?.content) ? block.content.map((c) => c?.text ?? '').join('') : '';
        if (content.includes('[distill]')) distillUsed = true;
        if (content.includes('distill converted')) converted = true;
      }
    }
  }
  return { result, lastText, malformed, toolCalls, toolUses, converted, distillUsed };
}

export function summarizeResult(parsed) {
  const { result } = parsed;
  if (result === null) return null;
  const usage = result.usage ?? {};
  return {
    isError: result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success'),
    subtype: result.subtype ?? null,
    text: typeof result.result === 'string' ? result.result : parsed.lastText,
    numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : null,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    },
  };
}
