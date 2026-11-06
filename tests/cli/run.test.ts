import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run';

function harness(startImpl?: (opts: unknown) => Promise<{ url: string; close(): Promise<void> }>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = vi.fn();
  const openUrl = vi.fn();
  const startServer = vi.fn(
    startImpl ?? (async (opts: { port: number }) => ({ url: `http://127.0.0.1:${opts.port}`, close: async () => {} })),
  );
  const deps = {
    startServer,
    openUrl,
    exit: exit as unknown as (code: number) => never,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    handleSignals: false,
  };
  return { deps, stdout, stderr, exit, openUrl, startServer };
}

describe('run', () => {
  it('starts with defaults and opens the browser', async () => {
    const h = harness();
    await run([], h.deps);
    expect(h.startServer).toHaveBeenCalledWith({ port: 4321, host: '127.0.0.1', maxBytes: 104857600 });
    expect(h.stdout).toEqual(['distill running at http://127.0.0.1:4321']);
    expect(h.openUrl).toHaveBeenCalledWith('http://127.0.0.1:4321');
    expect(h.stderr).toEqual([]);
  });

  it('accepts the explicit web command', async () => {
    const h = harness();
    await run(['web', '--port', '5000'], h.deps);
    expect(h.startServer).toHaveBeenCalledWith({ port: 5000, host: '127.0.0.1', maxBytes: 104857600 });
  });

  it('skips opening with --no-open', async () => {
    const h = harness();
    await run(['--no-open'], h.deps);
    expect(h.openUrl).not.toHaveBeenCalled();
    expect(h.startServer).toHaveBeenCalledOnce();
  });

  it('converts --max-size megabytes to bytes', async () => {
    const h = harness();
    await run(['--max-size', '5', '--no-open'], h.deps);
    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 5242880 }));
  });

  it.each([['abc'], ['70000'], ['-1'], ['1.5']])('exits 2 on invalid port %s', async (port) => {
    const h = harness();
    h.exit.mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(run(['--port', port], h.deps)).rejects.toThrow('exit');
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr).toHaveLength(1);
    expect(h.startServer).not.toHaveBeenCalled();
  });

  it.each([['0'], ['-3'], ['x']])('exits 2 on invalid max-size %s', async (size) => {
    const h = harness();
    h.exit.mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(run(['--max-size', size], h.deps)).rejects.toThrow('exit');
    expect(h.exit).toHaveBeenCalledWith(2);
    expect(h.stderr).toHaveLength(1);
  });

  it('reports EADDRINUSE and exits 1', async () => {
    const h = harness(async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    });
    await run(['--no-open'], h.deps);
    expect(h.stderr).toEqual(['Port 4321 is in use. Try --port 4322']);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('reports other startup errors and exits 1', async () => {
    const h = harness(async () => {
      throw new Error('boom');
    });
    await run(['--no-open'], h.deps);
    expect(h.stderr).toEqual(['Failed to start distill: boom']);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('warns when listening on a non-loopback host', async () => {
    const h = harness();
    await run(['--host', '0.0.0.0', '--no-open'], h.deps);
    expect(h.stderr).toEqual(['Warning: listening on 0.0.0.0 — anyone on your network can reach distill']);
  });

  it('does not warn on loopback hosts', async () => {
    const h = harness();
    await run(['--host', 'localhost', '--no-open'], h.deps);
    expect(h.stderr).toEqual([]);
  });
});
