import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import { buildOutline, renderOutline } from '../../src/core/outline';
import { estimateSavings, savingsNote } from '../../src/core/savings';
import { countTokens } from '../../src/core/tokens';
import { handleClaudePreToolUse } from '../../src/hooks/claude';

let base: string;
let proj: string;
let home: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'distill-claude-')));
  proj = join(base, 'proj');
  home = join(base, 'home');
  mkdirSync(proj);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

const deps = (extra: Record<string, unknown> = {}) => ({ homeDir: home, managedSettingsPaths: [], ...extra });

describe('handleClaudePreToolUse', () => {
  it('rewrites a pdf read and keeps offset and limit', async () => {
    const file = pdf();
    const convert = vi.fn(async () => ({ path: '/cache/out.md' }));
    const result = await handleClaudePreToolUse(payload({ file_path: file, offset: 3, limit: 10 }), convert, deps());
    expect(convert).toHaveBeenCalledWith(file);
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { file_path: '/cache/out.md', offset: 3, limit: 10 },
        permissionDecision: 'allow',
        permissionDecisionReason: 'distill: converted copy in its cache',
        additionalContext: `distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`,
      },
    });
  });

  describe('savings note', () => {
    const savings = estimateSavings({ kind: 'PDF', pages: 7, tokens: { raw: 1813, out: 1731 } });
    const context = (result: unknown): string => (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

    it('appends the note on its own line', async () => {
      const file = pdf();
      const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', savings }), deps());
      expect(context(result)).toBe(`distill converted b.pdf to Markdown to save tokens. Original file: ${file}.\n${savingsNote(savings)}`);
    });

    it('omits the note when disabled', async () => {
      const file = pdf();
      const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', savings }), deps({ savingsNote: false }));
      expect(context(result)).toBe(`distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`);
    });

    it('records usage once together with the note', async () => {
      const file = pdf();
      const recordUsage = vi.fn();
      await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', savings }), deps({ recordUsage }));
      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith(file, savings);
    });

    it('records usage even when the note text is disabled', async () => {
      const recordUsage = vi.fn();
      await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => ({ path: '/c.md', savings }), deps({ savingsNote: false, recordUsage }));
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    it('adds no note and records nothing for reads with offset or limit', async () => {
      for (const extra of [{ offset: 3 }, { limit: 10 }, { offset: 3, limit: 10 }]) {
        const file = pdf();
        const recordUsage = vi.fn();
        const result = await handleClaudePreToolUse(payload({ file_path: file, ...extra }), async () => ({ path: '/c.md', savings }), deps({ recordUsage }));
        expect(context(result)).toBe(`distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`);
        expect(recordUsage).not.toHaveBeenCalled();
      }
    });

    it('omits the note when convert reports no savings', async () => {
      const result = await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => ({ path: '/c.md' }), deps());
      expect(context(result)).not.toContain('[distill]');
    });
  });

  it('approves only together with a rewrite', async () => {
    const result = (await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => ({ path: '/c.md' }), deps())) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'b.png') }), async () => ({ path: '/c.md' }), deps())).toBeNull();
  });

  it('passes through reads with pages', async () => {
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf(), pages: '1-3' }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through images and other tools', async () => {
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'b.png') }), convert, deps())).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }, { tool_name: 'Bash' }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('resolves relative paths against cwd', async () => {
    const file = pdf('x.pdf');
    const convert = vi.fn(async () => ({ path: '/c.md' }));
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
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    for (const bad of [null, 'x', 42, {}, { tool_name: 'Read' }, { tool_name: 'Read', tool_input: { file_path: 3 } }]) {
      expect(await handleClaudePreToolUse(bad, convert, deps())).toBeNull();
    }
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through a path outside the cwd', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf('o.pdf', outside) }), convert, deps())).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: `${proj}/../outside/o.pdf` }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not treat a sibling with the cwd as a prefix as inside', async () => {
    const sibling = `${proj}-evil`;
    mkdirSync(sibling);
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf('s.pdf', sibling) }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through a symlink inside the cwd that points outside', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const target = pdf('o.pdf', outside);
    symlinkSync(target, join(proj, 'link.pdf'));
    symlinkSync(outside, join(proj, 'dir'));
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'link.pdf') }), convert, deps())).toBeNull();
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'dir', 'o.pdf') }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('passes through a missing file', async () => {
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'nope.pdf') }), convert, deps())).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  describe('Read deny rules', () => {
    const settingsFiles = (): string[] => [
      join(home, '.claude', 'settings.json'),
      join(proj, '.claude', 'settings.json'),
      join(proj, '.claude', 'settings.local.json'),
    ];

    it.each([0, 1, 2])('converts when settings file %i has a Read deny rule that does not cover the file', async (index) => {
      const file = settingsFiles()[index];
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash(rm:*)', 'Read(./secrets/**)'] } }));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).not.toBeNull();
      expect(convert).toHaveBeenCalledTimes(1);
    });

    const writeSettings = (file: string, permissions: Record<string, unknown>): void => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ permissions }));
    };

    it('converts when an unrelated deny rule exists', async () => {
      writeSettings(join(proj, '.claude', 'settings.json'), { deny: ['Read(./.env)'] });
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      const result = (await handleClaudePreToolUse(payload({ file_path: pdf('b.pdf') }), convert, deps())) as {
        hookSpecificOutput: { updatedInput: { file_path: string } };
      };
      expect(result.hookSpecificOutput.updatedInput.file_path).toBe('/c.md');
    });

    it('steps aside when a deny rule matches the file', async () => {
      writeSettings(join(proj, '.claude', 'settings.json'), { deny: ['Read(./secret.pdf)'] });
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf('secret.pdf') }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('steps aside when an ask rule matches the file', async () => {
      writeSettings(join(proj, '.claude', 'settings.json'), { ask: ['Read(./secrets/**)'] });
      mkdirSync(join(proj, 'secrets'));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf('a.pdf', join(proj, 'secrets')) }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('steps aside for a symlink into a denied folder', async () => {
      writeSettings(join(proj, '.claude', 'settings.json'), { deny: ['Read(./secrets/**)'] });
      mkdirSync(join(proj, 'secrets'));
      const real = pdf('real.pdf', join(proj, 'secrets'));
      symlinkSync(real, join(proj, 'link.pdf'));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: join(proj, 'link.pdf') }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('steps aside when the cache is denied', async () => {
      writeSettings(join(home, '.claude', 'settings.json'), { deny: ['Read(~/.cache/**)'] });
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('steps aside on a user-level /-relative rule', async () => {
      writeSettings(join(home, '.claude', 'settings.json'), { deny: ['Read(/docs/**)'] });
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('passes through when a settings file cannot be parsed', async () => {
      const file = settingsFiles()[1];
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '{ nope');
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).toBeNull();
    });

    it('converts when deny rules do not concern Read', async () => {
      const file = settingsFiles()[0];
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).not.toBeNull();
      expect(convert).toHaveBeenCalledTimes(1);
    });

    it('passes through when a project-root deny rule applies and cwd is a subdirectory', async () => {
      const sub = join(proj, 'sub');
      mkdirSync(join(sub, 'private'), { recursive: true });
      mkdirSync(join(proj, '.claude'));
      writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./sub/private/**)'] } }));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      const file = pdf('x.pdf', join(sub, 'private'));
      expect(await handleClaudePreToolUse(payload({ file_path: file }, { cwd: sub }), convert, deps())).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('converts when a Read ask rule does not cover the file', async () => {
      mkdirSync(join(proj, '.claude'));
      writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { ask: ['Read(./docs/**)'] } }));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).not.toBeNull();
      expect(convert).toHaveBeenCalledTimes(1);
    });

    it('passes through when a managed settings file denies Read', async () => {
      const managed = join(base, 'managed-settings.json');
      writeFileSync(managed, JSON.stringify({ permissions: { deny: ['Read(**/*.pdf)'] } }));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps({ managedSettingsPaths: [managed] }))).toBeNull();
      expect(convert).not.toHaveBeenCalled();
    });

    it('converts when a CLAUDE_PROJECT_DIR rule does not cover the file', async () => {
      const sub = join(proj, 'sub');
      mkdirSync(sub);
      mkdirSync(join(proj, '.claude'));
      writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./x/**)'] } }));
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf('y.pdf', sub) }, { cwd: sub }), convert, deps({ projectDir: proj }))).not.toBeNull();
    });
  });

  describe('CLAUDE_PROJECT_DIR root', () => {
    it('converts a file in a sibling subdirectory when cwd is a subdirectory', async () => {
      const a = join(proj, 'a');
      const b = join(proj, 'b');
      mkdirSync(a);
      mkdirSync(b);
      const file = pdf('s.pdf', b);
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: file }, { cwd: a }), convert, deps({ projectDir: proj }))).not.toBeNull();
      expect(convert).toHaveBeenCalledWith(file);
    });

    it('still blocks files outside both roots', async () => {
      const a = join(proj, 'a');
      const outside = join(base, 'outside');
      mkdirSync(a);
      mkdirSync(outside);
      const convert = vi.fn(async () => ({ path: '/c.md' }));
      expect(await handleClaudePreToolUse(payload({ file_path: pdf('o.pdf', outside) }, { cwd: a }), convert, deps({ projectDir: proj }))).toBeNull();
    });
  });
});

describe('plugin mode', () => {
  const ownHook = (command = 'distill-llm hook claude') => ({
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command, timeout: 120 }] }] },
  });
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('defers when the user settings have the own hook', async () => {
    write(join(home, '.claude', 'settings.json'), ownHook());
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps({ plugin: true }))).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('defers when the project local settings have the own hook', async () => {
    write(join(proj, '.claude', 'settings.local.json'), ownHook('npx -y distill-llm@0.3.0 hook claude'));
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps({ plugin: true }))).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('converts when only unrelated hooks exist', async () => {
    write(join(home, '.claude', 'settings.json'), ownHook('other-tool hook claude'));
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps({ plugin: true }))).not.toBeNull();
    expect(convert).toHaveBeenCalled();
  });

  it('converts when the hooks section is malformed', async () => {
    write(join(home, '.claude', 'settings.json'), { hooks: { PreToolUse: [null, 'x', { hooks: 'y' }, { hooks: [null, { command: 5 }] }] } });
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps({ plugin: true }))).not.toBeNull();
  });

  it('ignores settings hooks when not in plugin mode', async () => {
    write(join(home, '.claude', 'settings.json'), ownHook());
    const convert = vi.fn(async () => ({ path: '/c.md' }));
    expect(await handleClaudePreToolUse(payload({ file_path: pdf() }), convert, deps())).not.toBeNull();
    expect(convert).toHaveBeenCalled();
  });
});

const bigMarkdown = (sections = 40): string =>
  Array.from({ length: sections }, (_, i) => `## Section ${i + 1}\n\n${`Paragraph about topic ${i + 1} with enough words to count. `.repeat(40)}`).join('\n\n');

describe('large document index', () => {
  const context = (result: unknown): string => (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  const input = (result: unknown): Record<string, unknown> => (result as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }).hookSpecificOutput.updatedInput;

  it('adds offset, limit and the index for a large document', async () => {
    const file = pdf();
    const markdown = bigMarkdown();
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', markdown }), deps());
    const lines = markdown.split('\n');
    const limit = input(result).limit as number;
    expect(input(result).offset).toBe(1);
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(countTokens(lines.slice(0, limit).join('\n'))).toBeLessThanOrEqual(2000);
    expect(countTokens(lines.slice(0, limit + 1).join('\n'))).toBeGreaterThan(2000);
    const ctx = context(result);
    expect(ctx).toContain(`distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`);
    expect(ctx).toContain(`This is a large document: ${lines.length} lines, ~${countTokens(markdown)} tokens. Only lines 1-${limit} were loaded.`);
    expect(ctx).toContain(`Read on ${file} using offset and limit from this index:\n${renderOutline(buildOutline(markdown), { name: 'b.pdf' })}`);
  });

  it('keeps the savings note after the index', async () => {
    const savings = estimateSavings({ kind: 'PDF', pages: 7, tokens: { raw: 1813, out: 1731 } });
    const result = await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => ({ path: '/c.md', markdown: bigMarkdown(), savings }), deps());
    expect(context(result).endsWith(`\n${savingsNote(savings)}`)).toBe(true);
  });

  it('leaves a small document unchanged', async () => {
    const file = pdf();
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', markdown: '# Small\n\nbody' }), deps());
    expect(input(result)).toEqual({ file_path: '/c.md' });
    expect(context(result)).toBe(`distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`);
  });

  it('passes an explicit offset or limit through unchanged', async () => {
    for (const extra of [{ offset: 5 }, { limit: 20 }]) {
      const result = await handleClaudePreToolUse(payload({ file_path: pdf(), ...extra }), async () => ({ path: '/c.md', markdown: bigMarkdown() }), deps());
      expect(input(result)).toEqual({ file_path: '/c.md', ...extra });
      expect(context(result)).not.toContain('large document');
    }
  });

  it('is disabled with indexMinTokens 0', async () => {
    const result = await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => ({ path: '/c.md', markdown: bigMarkdown() }), deps({ indexMinTokens: 0 }));
    expect(input(result)).toEqual({ file_path: '/c.md' });
  });

  it('honours a custom threshold', async () => {
    const result = await handleClaudePreToolUse(payload({ file_path: pdf() }), async () => ({ path: '/c.md', markdown: bigMarkdown(3) }), deps({ indexMinTokens: 100 }));
    expect(input(result).offset).toBe(1);
  });
});

describe('run hook claude large document', () => {
  it('builds the index over the cached file, header included, fresh and cached', async () => {
    const file = pdf();
    const markdown = bigMarkdown();
    const make = () => {
      const h = harness(JSON.stringify(payload({ file_path: file })), {}, undefined, async () => ({ name: 'b.pdf', markdown, tokens: { raw: 90000, out: 20000 } }) as never);
      return h;
    };
    for (const round of [0, 1]) {
      const h = make();
      await run(['hook', 'claude'], h.deps);
      const out = JSON.parse(h.stdout[0]).hookSpecificOutput;
      const cached = readFileSync(out.updatedInput.file_path, 'utf8').split('\n');
      expect(out.updatedInput.offset).toBe(1);
      const row = /L(\d+)-(\d+) · [\d,]+ tok · ## Section 7$/m.exec(out.additionalContext);
      expect(row).not.toBeNull();
      expect(cached[Number(row?.[1]) - 1]).toBe('## Section 7');
      expect(h.openDistiller).toHaveBeenCalledTimes(round === 0 ? 1 : 0);
    }
  });

  it('DISTILL_INDEX_MIN_TOKENS=0 disables the index', async () => {
    const h = harness(JSON.stringify(payload({ file_path: pdf() })), { DISTILL_INDEX_MIN_TOKENS: '0' }, undefined, async () => ({ name: 'b.pdf', markdown: bigMarkdown(), tokens: { raw: 9, out: 9 } }) as never);
    await run(['hook', 'claude'], h.deps);
    expect(JSON.parse(h.stdout[0]).hookSpecificOutput.updatedInput.offset).toBeUndefined();
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

describe('visual pages', () => {
  const context = (result: unknown): string => (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  const savings = estimateSavings({ kind: 'PDF', pages: 7, tokens: { raw: 1813, out: 1731 } });
  const lead = (file: string) => `distill converted b.pdf to Markdown to save tokens. Original file: ${file}.`;
  const figure = (page: string) => `<!-- page ${page}: figure (chart or image not in this text; see the original page) -->`;
  const scan = (page: string) => `<!-- page ${page}: scan (OCR text) -->`;
  const doc = (...markers: string[]) => `${markers.join('\n\ntext\n\n')}\n\ntext\n`;

  it('points at two figure pages before the savings note', async () => {
    const file = pdf();
    const markdown = doc('<!-- page 1 -->', '<!-- page 2 -->', figure('4'), figure('9'));
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', savings, markdown }), deps());
    expect(context(result)).toBe(
      `${lead(file)}\nPages 4 and 9 contain charts or images that are not in this Markdown. If the question depends on them, Read the original with pages: "4".\n${savingsNote(savings)}`,
    );
  });

  it('names a single figure page', async () => {
    const file = pdf();
    const markdown = doc('<!-- page 1 -->', figure('3'));
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', markdown }), deps());
    expect(context(result)).toBe(`${lead(file)}\nPage 3 contains a chart or image that is not in this Markdown. If the question depends on it, Read the original with pages: "3".`);
  });

  it('lists more than two pages with commas', async () => {
    const file = pdf();
    const markdown = doc(figure('2'), figure('5'), figure('8'));
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', markdown }), deps());
    expect(context(result)).toContain('Pages 2, 5 and 8 contain charts or images');
    expect(context(result)).toContain('pages: "2"');
  });

  it('says nothing for scans and plain pages', async () => {
    const file = pdf();
    const markdown = doc('<!-- page 1 -->', scan('2'));
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', markdown }), deps());
    expect(context(result)).toBe(lead(file));
  });

  it('stays out of paged reads', async () => {
    const file = pdf();
    const markdown = doc('<!-- page 1 -->', figure('2'));
    const result = await handleClaudePreToolUse(payload({ file_path: file, limit: 5 }), async () => ({ path: '/c.md', markdown }), deps());
    expect(context(result)).toBe(lead(file));
  });

  it('goes before the index of a large document', async () => {
    const file = pdf();
    const body = Array.from({ length: 400 }, (_, i) => `row ${i} alpha beta gamma delta`).join('\n');
    const markdown = `<!-- page 1 -->\n\n${body}\n\n${figure('2')}\n\n${body}\n`;
    const result = await handleClaudePreToolUse(payload({ file_path: file }), async () => ({ path: '/c.md', markdown }), deps({ indexMinTokens: 100 }));
    const text = context(result);
    expect(text.indexOf('Page 2 contains a chart')).toBeGreaterThan(-1);
    expect(text.indexOf('Page 2 contains a chart')).toBeLessThan(text.indexOf('Index of'));
  });
});
