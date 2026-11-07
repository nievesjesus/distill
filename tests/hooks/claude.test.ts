import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { handleClaudePreToolUse } from '../../src/hooks/claude';

let base: string;
let proj: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'distill-claude-')));
  proj = join(base, 'proj');
  home = join(base, 'home');
  mkdirSync(proj);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const payload = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  session_id: 's',
  cwd: proj,
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: toolInput,
  tool_use_id: 't',
  ...extra,
});

const pdf = (name = 'b.pdf', dir = proj): string => {
  const file = join(dir, name);
  writeFileSync(file, 'x');
  return file;
};

const deps = () => ({ homeDir: home });

describe('handleClaudePreToolUse', () => {
  it('rewrites a pdf read and keeps offset and limit', async () => {
    const file = pdf();
    const convert = vi.fn(async () => '/cache/out.md');
    const result = await handleClaudePreToolUse(payload({ file_path: file, offset: 3, limit: 10 }), convert, deps());
    expect(convert).toHaveBeenCalledWith(file);
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { file_path: '/cache/out.md', offset: 3, limit: 10 },
        additionalContext: `distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`,
      },
    });
  });

  it('never sets a permission decision', async () => {
    const result = (await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => '/c.md', deps())) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(result.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('passes through reads with pages', async () => {
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: pdf(), pages: '1-3' }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through images and other tools', async () => {
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'b.png') }), convert, deps())).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }, { tool_name: 'Bash' }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('resolves relative paths against cwd', async () => {
    const file = pdf('x.pdf');
    const convert = vi.fn(async () => '/c.md');
    await handleClaudePreToolUse(payload({ file_path: 'x.pdf' }), convert, deps());
    expect(convert).toHaveBeenCalledWith(file);
  });

  it('passes through when convert throws', async () => {
    const convert = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).toBeNull();
  });

  it('passes through garbage payloads', async () => {
    const convert = vi.fn(async () => '/c.md');
    for (const bad of [null, 'x', 42, {}, { tool_name: 'Read' }, { tool_name: 'Read', tool_input: { file_path: 3 } }]) {
      expect(await handleClaudePreToolUse(bad, convert, deps())).toBeNull();
    }
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through a path outside the cwd', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: pdf('o.pdf', outside) }), convert, deps())).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: `${proj}/../outside/o.pdf` }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not treat a sibling with the cwd as a prefix as inside', async () => {
    const sibling = `${proj}-evil`;
    mkdirSync(sibling);
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: pdf('s.pdf', sibling) }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through a symlink inside the cwd that points outside', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const target = pdf('o.pdf', outside);
    symlinkSync(target, join(proj, 'link.pdf'));
    symlinkSync(outside, join(proj, 'dir'));
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'link.pdf') }), convert, deps())).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'dir', 'o.pdf') }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through a missing file', async () => {
    const convert = vi.fn(async () => '/c.md');
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'nope.pdf') }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  describe('Read deny rules', () => {
    const settingsFiles = (): string[] => [
      join(home, '.claude', 'settings.json'),
      join(proj, '.claude', 'settings.json'),
      join(proj, '.claude', 'settings.local.json'),
    ];

    it.each([0, 1, 2])('passes through when settings file %i has a Read deny rule', async (index) => {
      const file = settingsFiles()[index];
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash(rm:*)', 'Read(./secrets/**)'] } }));
      const convert = vi.fn(async () => '/c.md');
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('passes through when a settings file cannot be parsed', async () => {
      const file = settingsFiles()[1];
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '{ nope');
      const convert = vi.fn(async () => '/c.md');
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).toBeNull();
    });

    it('converts when deny rules do not concern Read', async () => {
      const file = settingsFiles()[0];
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
      const convert = vi.fn(async () => '/c.md');
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).not.toBeNull();
      expect(convert).toHaveBeenCalledTimes(1);
    });
  });
});

function harness(stdin: string, env: Record<string, string | undefined> = {}, cacheDir?: string, convertImpl?: () => Promise<never>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const close = vi.fn();
  const distillFile = vi.fn(
    convertImpl ?? (async () => ({ name: 'b.pdf', markdown: '# T', tokens: { raw: 10, out: 5 } })),
  );
  const openDistiller = vi.fn(async () => ({ close, distillFile }) as never);
  const deps = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    exit: exit as unknown as (code: number) => never,
    handleSignals: false,
    env,
    openDistiller,
    readStdin: async () => stdin,
    cacheDir: cacheDir ?? join(base, 'cache'),
    homeDir: home,
  };
  return { deps, stdout, stderr, exit, openDistiller, close };
}

describe('run hook claude', () => {
  it('prints nothing and exits 0 without opening the distiller for non-matching reads', async () => {
    const h = harness(JSON.stringify(payload({ file_path: join(proj, 'b.png') })));
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.openDistiller).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalledWith(2);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });

  it('passes through for DISTILL_HOOK=off without opening the distiller', async () => {
    const h = harness(JSON.stringify(payload({ file_path: pdf() })), { DISTILL_HOOK: 'off' });
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

  it('logs one stderr line, prints nothing, exits 0 and closes the distiller when conversion fails', async () => {
    const h = harness(JSON.stringify(payload({ file_path: pdf() })), {}, undefined, async () => {
      throw new Error('parse boom');
    });
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toMatch(/^distill hook: /);
    expect(h.openDistiller).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });

  it('logs one stderr line when the distiller cannot open', async () => {
    const h = harness(JSON.stringify(payload({ file_path: pdf() })));
    h.openDistiller.mockRejectedValueOnce(new Error('no parser'));
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(['distill hook: no parser']);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });

  it('prints exactly one JSON object on success and closes the distiller', async () => {
    const h = harness(JSON.stringify(payload({ file_path: pdf() })));
    await run(['hook', 'claude'], h.deps);
    expect(h.stdout).toHaveLength(1);
    const out = JSON.parse(h.stdout[0]);
    expect(out.hookSpecificOutput.updatedInput.file_path).toMatch(/\.md$/);
    expect(h.stderr).toEqual([]);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });

  it('does not open the distiller when the conversion is already cached', async () => {
    const file = pdf();
    const first = harness(JSON.stringify(payload({ file_path: file })));
    await run(['hook', 'claude'], first.deps);
    expect(first.openDistiller).toHaveBeenCalledTimes(1);

    const second = harness(JSON.stringify(payload({ file_path: file })));
    await run(['hook', 'claude'], second.deps);
    expect(second.stdout).toHaveLength(1);
    expect(second.openDistiller).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });

  it('exits 0 on extra arguments and unknown options', async () => {
    for (const extra of [['extra'], ['--bogus']]) {
      const h = harness(JSON.stringify(payload({ file_path: join(proj, 'b.png') })));
      await run(['hook', 'claude', ...extra], h.deps);
      expect(h.stdout).toEqual([]);
      expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
    }
  });

  it('does not throw when close throws', async () => {
    const h = harness(JSON.stringify(payload({ file_path: pdf() })), {}, undefined, async () => {
      throw new Error('parse boom');
    });
    h.close.mockImplementation(() => {
      throw new Error('close boom');
    });
    await expect(run(['hook', 'claude'], h.deps)).resolves.toBeUndefined();
    expect(h.exit.mock.calls.every(([code]) => code === 0)).toBe(true);
  });
});

describe('run hook convert', () => {
  it('exits 1 with empty stdout when conversion fails', async () => {
    const h = harness('', {}, undefined, async () => {
      throw new Error('parse boom');
    });
    await run(['hook', 'convert', pdf()], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('resolves relative files against the injected cwd', async () => {
    pdf('rel.pdf');
    const h = harness('');
    await run(['hook', 'convert', 'rel.pdf'], { ...h.deps, cwd: proj });
    expect(h.exit).not.toHaveBeenCalled();
    expect(JSON.parse(h.stdout[0]).path).toMatch(/\.md$/);
  });

  it('exits 1 for unsupported kinds without opening the distiller', async () => {
    const h = harness('');
    await run(['hook', 'convert', '/a/b.png'], h.deps);
    expect(h.stdout).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.openDistiller).not.toHaveBeenCalled();
  });
});
