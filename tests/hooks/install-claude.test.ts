import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOnPath, hookCommand, isEphemeralPath } from '../../src/hooks/command';
import { planClaudeInstall, planClaudeUninstall } from '../../src/hooks/install-claude';

const RULE = 'Read(~/.cache/distillmd/out/**)';
const ENTRY = { matcher: 'Read', hooks: [{ type: 'command', command: 'distillmd hook claude', timeout: 120 }] };

describe('hookCommand', () => {
  it('uses distillmd when it is on the PATH', () => {
    expect(hookCommand({ which: () => '/usr/bin/distillmd', version: '1.2.3' })).toBe('distillmd');
  });

  it('falls back to npx pinned to the version', () => {
    expect(hookCommand({ which: () => null, version: '1.2.3' })).toBe('npx -y distill-llm@1.2.3');
  });

  it('always uses npx under npm exec even when a binary is on the PATH', () => {
    expect(hookCommand({ which: () => '/usr/bin/distillmd', version: '1.2.3', npmCommand: 'exec' })).toBe('npx -y distill-llm@1.2.3');
  });

  it('keeps using the binary for other npm commands', () => {
    expect(hookCommand({ which: () => '/usr/bin/distillmd', version: '1.2.3', npmCommand: 'run-script' })).toBe('distillmd');
  });
});

describe('isEphemeralPath', () => {
  it.each([
    '/p/node_modules/.bin/distillmd',
    '/home/u/.npm/_npx/abc123/node_modules/.bin/distillmd',
    'C:\\Users\\u\\AppData\\npm-cache\\_npx\\abc\\distillmd.cmd',
    'C:\\p\\node_modules\\.bin\\distillmd.cmd',
  ])('flags %s', (path) => {
    expect(isEphemeralPath(path)).toBe(true);
  });

  it.each(['/usr/local/bin/distillmd', '/home/u/.nvm/versions/node/v22/bin/distillmd'])('accepts %s', (path) => {
    expect(isEphemeralPath(path)).toBe(false);
  });
});

describe('findOnPath', () => {
  const makeBin = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'distillmd');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  };

  it.skipIf(process.platform === 'win32')('skips node_modules/.bin and _npx entries and finds the real binary', () => {
    const base = mkdtempSync(join(tmpdir(), 'distill-which-'));
    try {
      const local = join(base, 'proj', 'node_modules', '.bin');
      const npx = join(base, 'cache', '_npx', 'abc', 'node_modules', '.bin');
      const real = join(base, 'bin');
      makeBin(local);
      makeBin(npx);
      makeBin(real);
      expect(findOnPath('distillmd', [local, npx, real].join(delimiter))).toBe(join(real, 'distillmd'));
      expect(findOnPath('distillmd', [local, npx].join(delimiter))).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('planClaudeInstall', () => {
  it('creates the settings from nothing', () => {
    const plan = planClaudeInstall(null, 'distillmd');
    expect(plan.changed).toBe(true);
    expect(plan.next.endsWith('\n')).toBe(true);
    expect(plan.next).toBe(`${JSON.stringify({ hooks: { PreToolUse: [ENTRY] }, permissions: { allow: [RULE] } }, null, 2)}\n`);
  });

  it('keeps other hooks and keys', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk-hook' }] };
    const current = JSON.stringify({
      model: 'opus',
      hooks: { PreToolUse: [other], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm)'] },
    });
    const next = JSON.parse(planClaudeInstall(current, 'distillmd').next);
    expect(next.model).toBe('opus');
    expect(next.hooks.Stop).toHaveLength(1);
    expect(next.hooks.PreToolUse).toEqual([other, ENTRY]);
    expect(next.permissions).toEqual({ allow: ['Bash(ls)', RULE], deny: ['Bash(rm)'] });
  });

  it('writes the npx command when given', () => {
    const next = JSON.parse(planClaudeInstall(null, 'npx -y distill-llm@1.0.0').next);
    expect(next.hooks.PreToolUse[0].hooks[0].command).toBe('npx -y distill-llm@1.0.0 hook claude');
  });

  it('is idempotent', () => {
    const first = planClaudeInstall(null, 'distillmd');
    const second = planClaudeInstall(first.next, 'distillmd');
    expect(second.changed).toBe(false);
    expect(second.next).toBe(first.next);
  });

  it('updates an own entry installed with a different command in place', () => {
    const first = planClaudeInstall(null, 'npx -y distill-llm@1.0.0');
    const plan = planClaudeInstall(first.next, 'distillmd');
    expect(plan.changed).toBe(true);
    const next = JSON.parse(plan.next);
    expect(next.hooks.PreToolUse).toHaveLength(1);
    expect(next.hooks.PreToolUse[0].hooks[0].command).toBe('distillmd hook claude');
    expect(planClaudeInstall(plan.next, 'distillmd').changed).toBe(false);
  });

  it.each(['distill-llm', 'npx -y distill-llm@1.0.0', 'npx -y distillmd@1.0.0'])('replaces an own entry installed as %s', (old) => {
    const first = planClaudeInstall(null, old);
    const plan = planClaudeInstall(first.next, 'distill-llm');
    const next = JSON.parse(plan.next);
    expect(next.hooks.PreToolUse).toHaveLength(1);
    expect(next.hooks.PreToolUse[0].hooks[0].command).toBe('distill-llm hook claude');
  });

  it('adds only the permission when the hook already exists', () => {
    const current = JSON.stringify({ hooks: { PreToolUse: [ENTRY] } });
    const plan = planClaudeInstall(current, 'distillmd');
    expect(plan.changed).toBe(true);
    const next = JSON.parse(plan.next);
    expect(next.hooks.PreToolUse).toHaveLength(1);
    expect(next.permissions.allow).toEqual([RULE]);
  });

  it('throws on invalid JSON', () => {
    expect(() => planClaudeInstall('{ nope', 'distillmd')).toThrow();
  });

  it('throws when the root is not an object', () => {
    expect(() => planClaudeInstall('[]', 'distillmd')).toThrow();
  });
});

describe('planClaudeUninstall', () => {
  it('removes everything it added and prunes empty containers', () => {
    const installed = planClaudeInstall(null, 'distillmd').next;
    const plan = planClaudeUninstall(installed);
    expect(plan.changed).toBe(true);
    expect(JSON.parse(plan.next)).toEqual({});
  });

  it.each(['distill-llm hook claude', 'npx -y distill-llm@1.0.0 hook claude'])('removes an entry installed as %s', (command) => {
    const current = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command, timeout: 120 }] }] } });
    expect(JSON.parse(planClaudeUninstall(current).next)).toEqual({});
  });

  it('keeps other entries and keys', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk-hook' }] };
    const current = JSON.stringify({
      model: 'opus',
      hooks: { PreToolUse: [other, ENTRY] },
      permissions: { allow: ['Bash(ls)', RULE] },
    });
    const next = JSON.parse(planClaudeUninstall(current).next);
    expect(next).toEqual({ model: 'opus', hooks: { PreToolUse: [other] }, permissions: { allow: ['Bash(ls)'] } });
  });

  it('reports no change when nothing is installed', () => {
    const current = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
    const plan = planClaudeUninstall(current);
    expect(plan.changed).toBe(false);
    expect(plan.next).toBe(current);
  });

  it('throws on invalid JSON', () => {
    expect(() => planClaudeUninstall('{ nope')).toThrow();
  });
});
