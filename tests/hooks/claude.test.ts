import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { handleClaudePreToolUse } from '../../src/hooks/claude';

const payload = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  session_id: 's',
  cwd: '/w',
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: toolInput,
  tool_use_id: 't',
  ...extra,
});

describe('handleClaudePreToolUse', () => {
  it('rewrites a pdf read and keeps offset and limit', async () => {
    const convert = vi.fn(async () => '/cache/out.md');
    const result = await handleClaudePreToolUse(payload({ file_path: '/a/b.pdf', offset: 3, limit: 10 }), convert);
    expect(convert).toHaveBeenCalledWith('/a/b.pdf');
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { file_path: '/cache/out.md', offset: 3, limit: 10 },
        additionalContext: 'distill converted b.pdf to Markdown to save tokens. Original file: /a/b.pdf.',
      },
    });
  });

  it('never sets a permission decision', async () => {
    const result = (await handleClaudePreToolUse(payload({ file_path: '/a/b.pdf' }), async () => '/c.md')) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(result.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('passes through reads with pages', async () => {
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: '/a/b.pdf', pages: '1-3' }), convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through images and other tools', async () => {
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: '/a/b.png' }), convert)).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: '/a/b.pdf' }, { tool_name: 'Bash' }), convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('resolves relative paths against cwd', async () => {
    const convert = vi.fn(async () => '/c.md');
    await handleClaudePreToolUse(payload({ file_path: 'x.pdf' }), convert);
    expect(convert).toHaveBeenCalledWith('/w/x.pdf');
  });

  it('passes through when convert throws', async () => {
    const convert = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await handleClaudePreToolUse(payload({ file_path: '/a/b.pdf' }), convert)).toBeNull();
  });

  it('passes through garbage payloads', async () => {
    const convert = vi.fn(async () => '/c.md');
    for (const bad of [null, 'x', 42, {}, { tool_name: 'Read' }, { tool_name: 'Read', tool_input: { file_path: 3 } }]) {
      expect(await handleClaudePreToolUse(bad, convert)).toBeNull();
    }
    expect(convert).not.toHaveBeenCalled();
  });
});

function harness(stdin: string, env: Record<string, string | undefined> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const close = vi.fn();
  const openDistiller = vi.fn(async () => ({ close }) as never);
  const deps = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    exit: exit as unknown as (code: number) => never,
    handleSignals: false,
    env,
    openDistiller,
    readStdin: async () => stdin,
  };
  return { deps, stdout, stderr, exit, openDistiller };
}

describe('run hook claude', () => {
  it('prints nothing and exits 0 without opening the distiller for non-matching reads', async () => {
    const h = harness(JSON.stringify(payload({ file_path: '/a/b.png' })));
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.openDistiller).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalledWith(2);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });

  it('passes through for DISTILL_HOOK=off without opening the distiller', async () => {
    const h = harness(JSON.stringify(payload({ file_path: '/a/b.pdf' })), { DISTILL_HOOK: 'off' });
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.openDistiller).not.toHaveBeenCalled();
  });

  it('warns on invalid JSON and still exits 0', async () => {
    const h = harness('not json');
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.length).toBe(1);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });

  it('closes the distiller and passes through when conversion fails', async () => {
    const h = harness(JSON.stringify(payload({ file_path: '/nonexistent/b.pdf' })));
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.openDistiller).toHaveBeenCalledTimes(1);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });
});

describe('run hook convert', () => {
  it('exits 1 with empty stdout when conversion fails', async () => {
    const h = harness('');
    await run(['hook', 'convert', '/nonexistent/b.pdf'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for unsupported kinds without opening the distiller', async () => {
    const h = harness('');
    await run(['hook', 'convert', '/a/b.png'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.openDistiller).not.toHaveBeenCalled();
  });
});
