import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Health } from '../../src/core/types';
import type { Distiller } from '../../src/node/distill';
import { DistillError } from '../../src/node/errors';
import { createMcpServer } from '../../src/mcp/server';

const HEALTH: Health = {
  version: '1.2.3',
  liteparseVersion: '2.0.0',
  libreoffice: true,
  lingua: { installed: false, installable: true, model: 'tinybert', state: 'idle', progress: 0 },
  maxBytes: 1024,
};

function fakeDistiller(calls: { path: string; opts: unknown }[] = []): Distiller {
  return {
    async distillFile(path, opts) {
      calls.push({ path, opts });
      const name = path.split('/').pop() as string;
      if (name.startsWith('bad')) throw new DistillError('parse_failed', 'broken file');
      return { path, name, kind: 'PDF', pages: 2, markdown: `# ${name}\n`, tokens: { raw: 100, out: 60 }, ms: 5 };
    },
    health: () => HEALTH,
    close: () => {},
  };
}

const clients: Client[] = [];

async function connect(deps: { distiller?: Distiller; resolvePath?: (p: string) => Promise<string> } = {}) {
  const server = createMcpServer({
    distiller: deps.distiller ?? fakeDistiller(),
    health: () => HEALTH,
    resolvePath: deps.resolvePath ?? (async (p) => p),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('createMcpServer', () => {
  it('lists the three tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['distill_capabilities', 'distill_file', 'distill_files']);
  });

  it('distill_file returns markdown text and structured tokens', async () => {
    const calls: { path: string; opts: unknown }[] = [];
    const client = await connect({ distiller: fakeDistiller(calls) });
    const result = await client.callTool({
      name: 'distill_file',
      arguments: { path: '/x/doc.pdf', boosters: ['dedupe', 'ws'], lingua: false },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: '# doc.pdf\n' }]);
    expect(result.structuredContent).toEqual({
      markdown: '# doc.pdf\n',
      tokens: { raw: 100, out: 60 },
      pages: 2,
      kind: 'PDF',
    });
    expect(calls[0]?.path).toBe('/x/doc.pdf');
    expect(calls[0]?.opts).toEqual({ boosters: new Set(['dedupe', 'ws']), lingua: false });
  });

  it('distill_file returns isError with code and message', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'distill_file', arguments: { path: '/x/bad.pdf' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'parse_failed: broken file' }]);
  });

  it('distill_file maps resolver errors to isError', async () => {
    const client = await connect({
      resolvePath: async () => {
        throw new DistillError('forbidden', 'Path is outside the allowed roots');
      },
    });
    const result = await client.callTool({ name: 'distill_file', arguments: { path: '/etc/passwd' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'forbidden: Path is outside the allowed roots' }]);
  });

  it('distill_file rejects invalid boosters', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf', boosters: ['nope'] } });
    expect(result.isError).toBe(true);
  });

  it('distill_files isolates failures per file', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'distill_files',
      arguments: { paths: ['/x/bad.pdf', '/x/good.pdf'] },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      results: [
        { path: '/x/bad.pdf', error: { code: 'parse_failed', message: 'broken file' } },
        { path: '/x/good.pdf', markdown: '# good.pdf\n', tokens: { raw: 100, out: 60 } },
      ],
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('# good.pdf');
    expect(text).toContain('parse_failed: broken file');
  });

  it('distill_files caps the number of paths at 20', async () => {
    const client = await connect();
    const paths = Array.from({ length: 21 }, (_, i) => `/x/f${i}.pdf`);
    const result = await client.callTool({ name: 'distill_files', arguments: { paths } });
    expect(result.isError).toBe(true);
  });

  it('distill_capabilities returns the health object', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'distill_capabilities', arguments: {} });
    expect(result.structuredContent).toEqual(HEALTH);
  });
});
