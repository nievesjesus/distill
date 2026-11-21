import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';
import type { AsrInstaller, AsrProgress, AsrStatus } from '../../src/node/asr-install';

const MB = 1024 * 1024;

function status(over: Partial<AsrStatus> = {}): AsrStatus {
  return { installed: false, runtime: false, models: false, ffmpeg: null, installable: true, diskBytes: 0, ...over };
}

function fakeInstaller(current: AsrStatus, feed: AsrProgress[] = [], failWith?: Error) {
  const install = vi.fn(async (options?: { onProgress?: (p: AsrProgress) => void }) => {
    for (const event of feed) options?.onProgress?.(event);
    if (failWith) throw failWith;
  });
  const uninstall = vi.fn(async (_model?: string) => {});
  const installer: AsrInstaller = { status: () => current, install, uninstall };
  return { installer, install, uninstall };
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
    env: { DISTILL_NO_UPDATE_CHECK: '1', DISTILL_NO_STATS: '1' },
    isTTY: false,
    ...extra,
  };
  return { deps, stdout, stderr, exit };
}

describe('asr status', () => {
  it('prints the status', async () => {
    const { installer } = fakeInstaller(status({ runtime: true, ffmpeg: '/opt/homebrew/bin/ffmpeg', diskBytes: 10_000_000 }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'status'], h.deps);
    expect(h.stdout).toEqual(['installed: no', 'runtime: yes', 'vad: no', 'models: none', 'default model: none', 'ffmpeg: /opt/homebrew/bin/ffmpeg', 'disk: 10.0 MB']);
  });

  it('lists each installed model with its size and the default', async () => {
    const { installer } = fakeInstaller(
      status({ installed: true, runtime: true, models: true, vad: true, model: 'whisper-small', defaultModel: 'whisper-small', installedModels: [{ name: 'parakeet', bytes: 670_576_784 }, { name: 'whisper-small', bytes: 375_484_327 }], diskBytes: 1_000_000_000 }),
    );
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'status'], h.deps);
    expect(h.stdout).toEqual([
      'installed: yes',
      'runtime: yes',
      'vad: yes',
      'models: parakeet (670.6 MB), whisper-small (375.5 MB)',
      'default model: whisper-small',
      'ffmpeg: not found',
      'disk: 1000.0 MB',
    ]);
  });

  it('says when ffmpeg is missing and when the platform is unsupported', async () => {
    const { installer } = fakeInstaller(status({ installable: false, unsupportedReason: 'no prebuilt for x' }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'status'], h.deps);
    expect(h.stdout).toContain('ffmpeg: not found');
    expect(h.stdout).toContain('unsupported: no prebuilt for x');
  });

  it('prints JSON with --json', async () => {
    const current = status({ runtime: true });
    const h = harness({ asrInstaller: fakeInstaller(current).installer });
    await run(['asr', 'status', '--json'], h.deps);
    expect(JSON.parse(h.stdout[0])).toEqual(current);
  });
});

describe('asr install', () => {
  it('asks first and downloads on yes', async () => {
    const { installer, install } = fakeInstaller(status());
    const prompt = vi.fn(async () => 'y');
    const h = harness({ asrInstaller: installer, isTTY: true, prompt });
    await run(['asr', 'install'], h.deps);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((prompt.mock.calls[0] as unknown as string[])[0]).toMatch(/35 MB.*6\d\d MB/s);
    expect(install).toHaveBeenCalledTimes(1);
    expect(h.stdout).toContain('Speech recognition installed (default model: parakeet).');
  });

  it('shows the sizes before asking', async () => {
    const h = harness({ asrInstaller: fakeInstaller(status()).installer, isTTY: true, prompt: async () => 'n' });
    await run(['asr', 'install'], h.deps);
    expect(h.stdout.join('\n')).toMatch(/35 MB/);
    expect(h.stdout.join('\n')).toMatch(/6\d\d MB/);
  });

  it('aborts on no', async () => {
    const { installer, install } = fakeInstaller(status());
    const h = harness({ asrInstaller: installer, isTTY: true, prompt: async () => 'n' });
    await run(['asr', 'install'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.stdout).toContain('Aborted.');
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('refuses without a TTY unless --yes is passed', async () => {
    const { installer, install } = fakeInstaller(status());
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.stderr.join('\n')).toMatch(/--yes/);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('--yes skips the prompt', async () => {
    const { installer, install } = fakeInstaller(status());
    const prompt = vi.fn(async () => 'n');
    const h = harness({ asrInstaller: installer, isTTY: true, prompt });
    await run(['asr', 'install', '--yes'], h.deps);
    expect(prompt).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('does nothing when already installed', async () => {
    const { installer, install } = fakeInstaller(status({ installed: true, runtime: true, models: true }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.stdout).toContain('Speech recognition is already installed.');
  });

  it('explains an unsupported platform and exits 1', async () => {
    const { installer, install } = fakeInstaller(status({ installable: false, unsupportedReason: 'no prebuilt for freebsd-x64' }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.stderr).toContain('no prebuilt for freebsd-x64');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('prints rate-limited progress to stderr', async () => {
    const total = 100 * MB;
    const feed = Array.from({ length: 200 }, (_, index) => ({ file: 'encoder.int8.onnx', done: Math.round(((index + 1) / 200) * total), total }));
    const { installer } = fakeInstaller(status(), feed);
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes'], h.deps);
    const lines = h.stderr.filter((line) => line.includes('%'));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThanOrEqual(101);
    expect(lines[lines.length - 1]).toContain('100%');
    expect(h.stdout.join('')).not.toContain('%');
  });

  it('reports a failed install and exits 1', async () => {
    const { installer } = fakeInstaller(status(), [], new Error('encoder.int8.onnx failed the sha256 check'));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes'], h.deps);
    expect(h.stderr.join('\n')).toContain('encoder.int8.onnx failed the sha256 check');
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});

describe('asr install --model', () => {
  it('passes the model to the installer and shows its own download size', async () => {
    const { installer, install } = fakeInstaller(status());
    const prompt = vi.fn(async () => 'y');
    const h = harness({ asrInstaller: installer, isTTY: true, prompt });
    await run(['asr', 'install', '--model', 'whisper-small'], h.deps);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ model: 'whisper-small' }));
    expect(h.stdout.join('\n')).toMatch(/35 MB.*376 MB.*whisper-small/s);
    expect((prompt.mock.calls[0] as unknown as string[])[0]).toMatch(/35 MB \+ 376 MB/);
  });

  it('defaults to parakeet', async () => {
    const { installer, install } = fakeInstaller(status());
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes'], h.deps);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ model: 'parakeet' }));
  });

  it('rejects an unknown model', async () => {
    const { installer, install } = fakeInstaller(status());
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes', '--model', 'whisper-large'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(2);
  });

  it('reports the model once it is installed', async () => {
    const h = harness({ asrInstaller: fakeInstaller(status()).installer });
    await run(['asr', 'install', '--yes', '--model', 'whisper-turbo'], h.deps);
    expect(h.stdout).toContain('Speech recognition installed (default model: whisper-turbo).');
  });

  it('only switches the default when the model is already installed', async () => {
    const { installer, install } = fakeInstaller(status({ installed: true, runtime: true, models: true, defaultModel: 'parakeet', installedModels: [{ name: 'parakeet', bytes: 1 }, { name: 'whisper-small', bytes: 1 }] }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes', '--model', 'whisper-small'], h.deps);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ model: 'whisper-small' }));
  });

  it('says so when the model is already the default', async () => {
    const { installer, install } = fakeInstaller(status({ installed: true, runtime: true, models: true, defaultModel: 'whisper-small' }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'install', '--yes', '--model', 'whisper-small'], h.deps);
    expect(install).not.toHaveBeenCalled();
    expect(h.stdout).toContain('Speech recognition is already installed.');
  });
});

describe('asr uninstall --model', () => {
  it('removes one model', async () => {
    const { installer, uninstall } = fakeInstaller(status({ installed: true }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'uninstall', '--model', 'whisper-turbo'], h.deps);
    expect(uninstall).toHaveBeenCalledWith('whisper-turbo');
    expect(h.stdout).toContain('Speech model whisper-turbo removed.');
  });

  it('removes everything without a model', async () => {
    const { installer, uninstall } = fakeInstaller(status({ installed: true }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'uninstall'], h.deps);
    expect(uninstall).toHaveBeenCalledWith(undefined);
  });
});

describe('asr uninstall', () => {
  it('removes the installation', async () => {
    const { installer, uninstall } = fakeInstaller(status({ installed: true }));
    const h = harness({ asrInstaller: installer });
    await run(['asr', 'uninstall'], h.deps);
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(h.stdout).toContain('Speech recognition removed.');
  });
});
