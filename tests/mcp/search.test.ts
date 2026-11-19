import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateSearchSavings, savingsNote } from '../../src/core/savings';
import { countTokens } from '../../src/core/tokens';
import type { DistillResult, Health } from '../../src/core/types';
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

const DOC = ['# Report', '<!-- page 1 -->', 'Intro text.', '## Costs', '<!-- page 2 -->', 'The total cost was 4,200', '000 euros.', 'Nothing else.'].join('\n');

function result(path: string, markdown: string, kind: DistillResult['kind'] = 'PDF'): DistillResult {
  return { path, name: path.split('/').pop() as string, kind, pages: 2, markdown, tokens: { raw: 5000, out: 3000 }, ms: 3 };
}

function fakeDistiller(calls: string[] = []): Distiller {
  return {
    async distillFile(path) {
      calls.push(path);
      if (path.endsWith('bad.pdf')) throw new DistillError('parse_failed', 'broken file');
      return result(path, DOC);
    },
    async distillUrl(url) {
      calls.push(url);
      return result(url, DOC, 'HTML');
    },
    renderPage: async () => {
      throw new Error('unused');
    },
    health: () => HEALTH,
    close: () => {},
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(distiller: Distiller, extra: { savingsNote?: boolean; recordUsage?: (kind: string, savings: unknown) => void } = {}) {
  const server = createMcpServer({ distiller, health: () => HEALTH, resolvePath: async (p) => p, stat: async () => ({ size: 1, mtimeMs: 1 }), ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

interface Structured {
  hits: { line: number; page?: number; section?: string; text: string }[];
  total: number;
  truncated: boolean;
  tokens: { raw: number; out: number };
  note?: string;
}

describe('distill_search', () => {
  it('is registered as read-only and routes agents away from whole reads and shell tools', async () => {
    const client = await connect(fakeDistiller());
    const tool = (await client.listTools()).tools.find((t) => t.name === 'distill_search');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(tool?.title?.length).toBeGreaterThan(0);
    const description = tool?.description ?? '';
    expect(description).toMatch(/instead of reading/i);
    expect(description).toContain('pdftotext');
    expect(description).toContain('distill_file');
    expect(description).toContain('section');
    expect(description).toContain('offset');
    expect(description).toMatch(/url/i);
  });

  it('finds a wrapped number with page and section and prints p.N L<line> lines', async () => {
    const client = await connect(fakeDistiller());
    const out = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: '4,200 000 euros', context: 0 } });
    expect(out.isError).toBeFalsy();
    const sc = out.structuredContent as Structured;
    expect(sc.total).toBe(1);
    expect(sc.truncated).toBe(false);
    expect(sc.hits[0]).toMatchObject({ line: 6, page: 2, section: 'Costs' });
    const text = (out.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('p.2 L6:');
    expect(sc.tokens.out).toBe(countTokens(text));
  });

  it('searches a url through the same conversion path', async () => {
    const calls: string[] = [];
    const client = await connect(fakeDistiller(calls));
    const out = await client.callTool({ name: 'distill_search', arguments: { url: 'https://a.example/', query: 'nothing else' } });
    expect((out.structuredContent as Structured).total).toBe(1);
    expect(calls).toEqual(['https://a.example/']);
  });

  it('converts once and reuses the cached Markdown', async () => {
    const calls: string[] = [];
    const client = await connect(fakeDistiller(calls));
    await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'intro' } });
    await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'costs' } });
    await client.callTool({ name: 'distill_file', arguments: { path: '/x/doc.pdf' } });
    expect(calls).toHaveLength(1);
  });

  it('requires exactly one of path and url', async () => {
    const client = await connect(fakeDistiller());
    const both = await client.callTool({ name: 'distill_search', arguments: { path: '/x/a.pdf', url: 'https://a.example/', query: 'x' } });
    expect(both.isError).toBe(true);
    expect(both.content).toEqual([{ type: 'text', text: 'bad_request: Pass either path or url, not both' }]);
    const neither = await client.callTool({ name: 'distill_search', arguments: { query: 'x' } });
    expect(neither.isError).toBe(true);
    expect(neither.content).toEqual([{ type: 'text', text: 'bad_request: Pass path or url' }]);
  });

  it('maps a bad regex to bad_request and conversion failures to their code', async () => {
    const client = await connect(fakeDistiller());
    const regex = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'a'.repeat(201), regex: true } });
    expect(regex.isError).toBe(true);
    expect((regex.content as { text: string }[])[0].text).toMatch(/^bad_request: .*too long/i);
    const bad = await client.callTool({ name: 'distill_search', arguments: { path: '/x/bad.pdf', query: 'x' } });
    expect(bad.content).toEqual([{ type: 'text', text: 'parse_failed: broken file' }]);
  });

  it('truncates at maxHits', async () => {
    const markdown = Array.from({ length: 6 }, (_, i) => `hit ${i}\n\n\n\n\n\n\n`).join('');
    const distiller = fakeDistiller();
    distiller.distillFile = async (path) => result(path, markdown);
    const client = await connect(distiller);
    const out = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'hit', context: 0, maxHits: 2 } });
    const sc = out.structuredContent as Structured;
    expect(sc.hits).toHaveLength(2);
    expect(sc.total).toBe(6);
    expect(sc.truncated).toBe(true);
  });

  it('reports a search savings note once per document and records usage', async () => {
    const recorded: { kind: string; savings: { basis: string } }[] = [];
    const client = await connect(fakeDistiller(), { recordUsage: (kind, savings) => recorded.push({ kind, savings: savings as { basis: string } }) });
    const first = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'intro' } });
    const second = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'costs' } });
    const sc = first.structuredContent as Structured;
    const text = (first.content as { text: string }[])[0].text;
    const expected = estimateSearchSavings(result('/x/doc.pdf', DOC), countTokens(text));
    expect(sc.note).toBe(savingsNote(expected));
    expect(sc.note).toContain('reading the whole document');
    expect((first.content as { text: string }[]).at(-1)?.text).toBe(sc.note);
    expect((second.structuredContent as Structured).note).toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: 'PDF', savings: { basis: 'search' } });
  });

  it('omits the note when notes are disabled', async () => {
    const client = await connect(fakeDistiller(), { savingsNote: false });
    const out = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'intro' } });
    expect((out.structuredContent as Structured).note).toBeUndefined();
  });

  it('says so when nothing matches', async () => {
    const client = await connect(fakeDistiller());
    const out = await client.callTool({ name: 'distill_search', arguments: { path: '/x/doc.pdf', query: 'zebra' } });
    const sc = out.structuredContent as Structured;
    expect(sc.hits).toEqual([]);
    expect(sc.total).toBe(0);
    expect((out.content as { text: string }[])[0].text).toMatch(/no matches/i);
  });
});
