import { describe, expect, it, vi } from 'vitest';
import { run, updateNotice } from '../../src/cli/run';
import type { UpdateCheck, InstallMethod } from '../../src/core/types';
import type { Distiller } from '../../src/node/distill';
import type { UpdateChecker } from '../../src/node/update-check';
import type { GlobalUpdater } from '../../src/node/update-install';

function info(over: Partial<UpdateCheck> = {}): UpdateCheck {
  return { current: '0.1.2', latest: '0.2.0', available: true, method: 'npm-global' as InstallMethod, enabled: true, disabledBy: null, checkedAt: null, ...over };
}

function fakeChecker(result: UpdateCheck): UpdateChecker & { check: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => result),
    check: vi.fn(async () => result),
    setEnabled: vi.fn(async () => result),
  } as unknown as UpdateChecker & { check: ReturnType<typeof vi.fn> };
}

function fakeUpdater(state: 'done' | 'failed' = 'done') {
  const install = vi.fn(async () => {});
  const updater: GlobalUpdater = {
    install,
    status: () => (state === 'done' ? { state: 'done', version: '0.2.0' } : { state: 'failed', error: 'boom' }),
  };
  return { updater, install };
}

function harness(extra: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const deps = {
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
    env: { DISTILL_NO_UPDATE_CHECK: '1' },
    isTTY: false,
    ...extra,
  };
  return { deps, stdout, stderr, exit };
}

describe('update command', () => {
  it('says up to date', async () => {
    const h = harness({ updateChecker: fakeChecker(info({ latest: '0.1.2', available: false })) });
    await run(['update'], h.deps);
    expect(h.stdout).toEqual(['distill-llm 0.1.2 is up to date.']);
  });

  it('installs with --yes', async () => {
    const { updater, install } = fakeUpdater();
    const h = harness({ updateChecker: fakeChecker(info()), globalUpdater: updater });
    await run(['update', '--yes'], h.deps);
    expect(install).toHaveBeenCalledWith('0.2.0');
    expect(h.stdout).toEqual(['distill-llm 0.2.0 is available (you have 0.1.2).', 'Updated to 0.2.0.']);
  });

  it('reports a failed install', async () => {
    const { updater } = fakeUpdater('failed');
    const h = harness({ updateChecker: fakeChecker(info()), globalUpdater: updater });
    await run(['update', '--yes'], h.deps);
    expect(h.stderr).toEqual(['boom']);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('installs after a yes on a TTY', async () => {
    const { updater, install } = fakeUpdater();
    const prompt = vi.fn(async () => 'y');
    const h = harness({ updateChecker: fakeChecker(info()), globalUpdater: updater, isTTY: true, prompt });
    await run(['update'], h.deps);
    expect(prompt).toHaveBeenCalledWith('Update now? [y/N] ');
    expect(install).toHaveBeenCalledWith('0.2.0');
  });

  it('prints the npm command without a TTY', async () => {
    const { updater, install } = fakeUpdater();
    const h = harness({ updateChecker: fakeChecker(info()), globalUpdater: updater });
    await run(['update'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.stdout).toContain('Run: npm install -g distill-llm@0.2.0');
  });

  it('prints npx distill-llm@latest for npx', async () => {
    const h = harness({ updateChecker: fakeChecker(info({ method: 'npx' })) });
    await run(['update'], h.deps);
    expect(h.stdout).toContain('Run: npx distill-llm@latest');
  });

  it('points desktop users to the app', async () => {
    const h = harness({ updateChecker: fakeChecker(info({ method: 'desktop' })) });
    await run(['update'], h.deps);
    expect(h.stdout).toContain('Open the desktop app to update it.');
  });

  it('fails when the registry is unreachable', async () => {
    const h = harness({ updateChecker: fakeChecker(info({ latest: null, available: false })) });
    await run(['update'], h.deps);
    expect(h.stderr).toEqual(['Could not reach the npm registry.']);
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});

describe('updateNotice', () => {
  it('is null when nothing is available', () => {
    expect(updateNotice(info({ available: false }))).toBeNull();
  });

  it('uses the method command', () => {
    expect(updateNotice(info({ method: 'docker' }))).toBe('distill-llm 0.2.0 is available (you have 0.1.2). Run: docker pull ghcr.io/nievesjesus/distill');
  });
});

function convertDeps(h: ReturnType<typeof harness>, checker: UpdateChecker) {
  const distiller: Distiller = {
    async distillFile(path) {
      return { path, name: 'a.pdf', kind: 'PDF', pages: 1, markdown: '# a\n', tokens: { raw: 10, out: 5 }, ms: 1 };
    },
    health: () => ({}) as ReturnType<Distiller['health']>,
    close: () => {},
  };
  return { ...h.deps, updateChecker: checker, openDistiller: async () => distiller };
}

describe('update notice in convert', () => {
  it('leaves convert --stdout untouched', async () => {
    const h = harness({ isTTY: true });
    await run(['convert', '--stdout', 'a.pdf'], convertDeps(h, fakeChecker(info())));
    expect(h.stdout).toEqual(['# a\n']);
    expect(h.stderr).toEqual([]);
  });

  it('prints the notice on a TTY', async () => {
    const h = harness({ isTTY: true });
    await run(['convert', '--out', '/tmp/distill-update-test', 'a.pdf'], convertDeps(h, fakeChecker(info())));
    expect(h.stderr).toContain('distill-llm 0.2.0 is available (you have 0.1.2). Run: distill-llm update');
  });

  it('prints nothing without a TTY', async () => {
    const h = harness({ isTTY: false });
    await run(['convert', '--out', '/tmp/distill-update-test', 'a.pdf'], convertDeps(h, fakeChecker(info())));
    expect(h.stderr).toEqual([]);
  });
});

describe('hooks never check', () => {
  it('hook claude does not call the checker', async () => {
    const checker = fakeChecker(info());
    checker.check.mockRejectedValue(new Error('should not be called'));
    const h = harness({ updateChecker: checker, readStdin: async () => '{}' });
    await run(['hook', 'claude'], h.deps).catch(() => {});
    expect(checker.check).not.toHaveBeenCalled();
  });
});
