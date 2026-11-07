import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { openCommand, run } from '../../src/cli/run';

function harness(
  startImpl?: (opts: unknown) => Promise<{ url: string; close(): Promise<void> }>,
  env: Record<string, string | undefined> = {},
) {
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
    env,
  };
  return { deps, stdout, stderr, exit, openUrl, startServer };
}

describe('run', () => {
  it('starts with defaults and opens the browser', async () => {
    const h = harness();
    await run([], h.deps);
    expect(h.startServer).toHaveBeenCalledWith({ port: 4321, host: '127.0.0.1', maxBytes: 104857600, allowedHosts: [] });
    expect(h.stdout).toEqual(['distill running at http://127.0.0.1:4321']);
    expect(h.openUrl).toHaveBeenCalledWith('http://127.0.0.1:4321');
    expect(h.stderr).toEqual([]);
  });

  it('accepts the explicit web command', async () => {
    const h = harness();
    await run(['web', '--port', '5000'], h.deps);
    expect(h.startServer).toHaveBeenCalledWith({ port: 5000, host: '127.0.0.1', maxBytes: 104857600, allowedHosts: [] });
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

  it('passes --allowed-hosts as a trimmed list', async () => {
    const h = harness();
    await run(['--host', '0.0.0.0', '--allowed-hosts', 'distill.home.arpa, .lan.example,', '--no-open'], h.deps);
    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ allowedHosts: ['distill.home.arpa', '.lan.example'] }));
  });

  it('reads allowed hosts from DISTILL_ALLOWED_HOSTS, and the flag wins over it', async () => {
    const fromEnv = harness(undefined, { DISTILL_ALLOWED_HOSTS: 'a.example,b.example' });
    await run(['--no-open'], fromEnv.deps);
    expect(fromEnv.startServer).toHaveBeenCalledWith(expect.objectContaining({ allowedHosts: ['a.example', 'b.example'] }));
    const flagWins = harness(undefined, { DISTILL_ALLOWED_HOSTS: 'a.example' });
    await run(['--allowed-hosts', 'c.example', '--no-open'], flagWins.deps);
    expect(flagWins.startServer).toHaveBeenCalledWith(expect.objectContaining({ allowedHosts: ['c.example'] }));
  });

  it('does not warn on loopback hosts', async () => {
    const h = harness();
    await run(['--host', 'localhost', '--no-open'], h.deps);
    expect(h.stderr).toEqual([]);
  });
});

describe('openCommand', () => {
  it('opens with rundll32 and verbatim arguments on Windows, never through cmd', () => {
    const command = openCommand('http://127.0.0.1:4321', 'win32');
    expect(command).toEqual({
      file: 'rundll32',
      args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4321'],
      windowsVerbatimArguments: true,
    });
    expect(command.file).not.toBe('cmd');
  });

  it('uses open on macOS and xdg-open elsewhere', () => {
    expect(openCommand('http://x', 'darwin')).toMatchObject({ file: 'open', args: ['http://x'] });
    expect(openCommand('http://x', 'linux')).toMatchObject({ file: 'xdg-open', args: ['http://x'] });
  });
});

describe('run mcp', () => {
  function mcpHarness() {
    const h = harness();
    const connectStdio = vi.fn(async () => {});
    const serveMcpHttp = vi.fn(async (opts: { port: number; host: string }) => ({
      url: `http://${opts.host}:${opts.port}/mcp`,
      close: async () => {},
    }));
    const openDistiller = vi.fn(async () => ({
      distillFile: vi.fn(),
      health: vi.fn(() => ({ version: '0.0.0' })),
      close: vi.fn(),
    }));
    return { ...h, connectStdio, serveMcpHttp, deps: { ...h.deps, connectStdio, serveMcpHttp, openDistiller } as never };
  }

  it('writes nothing to stdout over stdio', async () => {
    const h = mcpHarness();
    await run(['mcp'], h.deps);
    expect(h.connectStdio).toHaveBeenCalledTimes(1);
    expect(h.stdout).toEqual([]);
    expect(h.serveMcpHttp).not.toHaveBeenCalled();
  });

  it('serves over http with defaults and logs the url to stderr', async () => {
    const h = mcpHarness();
    await run(['mcp', '--http'], h.deps);
    expect(h.serveMcpHttp).toHaveBeenCalledWith(expect.objectContaining({ port: 4322, host: '127.0.0.1', allowedHosts: [] }));
    expect(h.stderr).toContain('distill MCP at http://127.0.0.1:4322/mcp');
    expect(h.stdout).toEqual([]);
  });

  it('forwards port, host and allowed hosts', async () => {
    const h = mcpHarness();
    await run(['mcp', '--http', '--port', '5000', '--host', '0.0.0.0', '--allowed-hosts', 'a.example,b.example', '--root', '/tmp'], h.deps);
    expect(h.serveMcpHttp).toHaveBeenCalledWith(
      expect.objectContaining({ port: 5000, host: '0.0.0.0', allowedHosts: ['a.example', 'b.example'] }),
    );
  });
});

describe('run mcp path confinement', () => {
  function setup() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'distill-mcp-cli-')));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, 'a.pdf'), 'x');
    writeFileSync(join(outside, 'b.pdf'), 'x');
    const h = harness();
    const seen: string[] = [];
    const distiller = {
      distillFile: vi.fn(async (path: string) => {
        seen.push(path);
        return { path, name: 'f.pdf', kind: 'PDF', pages: 1, markdown: 'm', tokens: { raw: 1, out: 1 }, ms: 1 };
      }),
      health: () => ({ version: '0.0.0' }),
      close: vi.fn(),
    };
    const openDistiller = vi.fn(async () => distiller);
    return { base, root, outside, h, seen, openDistiller, distiller };
  }

  async function call(server: McpServer, path: string) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const result = await client.callTool({ name: 'distill_file', arguments: { path } });
    await client.close();
    return result;
  }

  it('confines http to --root', async () => {
    const t = setup();
    let create: (() => McpServer) | undefined;
    const serveMcpHttp = vi.fn(async (opts: { createServer: () => McpServer }) => {
      create = opts.createServer;
      return { url: 'http://127.0.0.1:4322/mcp', close: async () => {} };
    });
    await run(['mcp', '--http', '--root', t.root], { ...t.h.deps, serveMcpHttp, openDistiller: t.openDistiller } as never);
    const denied = await call((create as () => McpServer)(), join(t.outside, 'b.pdf'));
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([{ type: 'text', text: 'forbidden: Path is outside the allowed roots' }]);
    const allowed = await call((create as () => McpServer)(), join(t.root, 'a.pdf'));
    expect(allowed.isError).toBeFalsy();
    expect(t.seen).toEqual([join(t.root, 'a.pdf')]);
  });

  it('fails cleanly for a missing --root', async () => {
    const t = setup();
    const serveMcpHttp = vi.fn();
    await run(['mcp', '--http', '--root', join(t.base, 'typo')], { ...t.h.deps, serveMcpHttp, openDistiller: t.openDistiller } as never);
    expect(serveMcpHttp).not.toHaveBeenCalled();
    expect(t.h.stderr[0]).toMatch(/^error: Root not found: /);
    expect(t.h.exit).toHaveBeenCalledWith(1);
    expect(t.h.stdout).toEqual([]);
  });

  it('does not confine stdio', async () => {
    const t = setup();
    let server: McpServer | undefined;
    const connectStdio = vi.fn(async (s: McpServer) => {
      server = s;
    });
    await run(['mcp'], { ...t.h.deps, connectStdio, openDistiller: t.openDistiller } as never);
    const result = await call(server as McpServer, join(t.outside, 'b.pdf'));
    expect(result.isError).toBeFalsy();
    expect(t.seen).toEqual([join(t.outside, 'b.pdf')]);
  });
});
