import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateSavings, savingsNote } from '../../src/core/savings';
import type { DistillResult, Health } from '../../src/core/types';
import type { DistillUrlOptions, Distiller } from '../../src/node/distill';
import { DistillError } from '../../src/node/errors';
import { createMcpServer } from '../../src/mcp/server';

const HEALTH: Health = {
  version: '1.2.3',
  liteparseVersion: '2.0.0',
  libreoffice: true,
  lingua: { installed: false, installable: true, model: 'tinybert', state: 'idle', progress: 0 },
  maxBytes: 1024,
};

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

interface UrlCall {
  url: string;
  opts: DistillUrlOptions | undefined;
}

function page(markdown: string, extra: Partial<DistillResult> = {}): DistillResult {
  return { path: 'https://docs.example.com/guide', name: 'Guide', kind: 'HTML', pages: 1, markdown, tokens: { raw: 20000, out: 800 }, ms: 4, ...extra };
}

function fakeDistiller(calls: UrlCall[], produce: (url: string) => DistillResult | Error): Distiller {
  return {
    async distillUrl(url, opts) {
      calls.push({ url, opts });
      const made = produce(url);
      if (made instanceof Error) throw made;
      return made;
    },
    distillFile: async () => {
      throw new Error('unused');
    },
    renderPage: async () => {
      throw new Error('unused');
    },
    health: () => HEALTH,
    close: () => {},
  };
}

async function connect(distiller: Distiller, extra: { ignoreRobotsTxt?: boolean; maxResultTokens?: number; now?: () => number; savingsNote?: boolean; recordUsage?: (kind: string, savings: unknown) => void } = {}) {
  const server = createMcpServer({ distiller, health: () => HEALTH, resolvePath: async (p) => p, ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

const SMALL = '<!-- distill: x -->\n\n# Guide\n\nHello.\n';
const SAVINGS = estimateSavings({ kind: 'HTML', pages: 1, tokens: { raw: 20000, out: 800 } });

describe('distill_url', () => {
  it('is registered as an open-world read-only tool and explains itself', async () => {
    const client = await connect(fakeDistiller([], () => page(SMALL)));
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'distill_url');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    const description = tool?.description ?? '';
    for (const phrase of ['web fetch', 'outline', 'section', 'private', 'robots.txt', 'untrusted', 'needs_javascript', 'forbidden', 'nextOffset']) {
      expect(description, phrase).toContain(phrase);
    }
  });

  it('returns the page as Markdown with the savings note against the raw page', async () => {
    const calls: UrlCall[] = [];
    const client = await connect(fakeDistiller(calls, () => page(SMALL)));
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://docs.example.com/guide' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: SMALL },
      { type: 'text', text: savingsNote(SAVINGS) },
    ]);
    expect(result.structuredContent).toMatchObject({ kind: 'HTML', pages: 1, tokens: { raw: 20000, out: 800 }, savings: SAVINGS, lines: { from: 1, to: 5, total: 5 } });
    expect(String((result.structuredContent as { note: string }).note)).toContain('vs the raw page');
  });

  it('respects robots.txt unless the server was started with the flag, and never allows private addresses', async () => {
    const calls: UrlCall[] = [];
    const strict = await connect(fakeDistiller(calls, () => page(SMALL)));
    await strict.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    const lax = await connect(fakeDistiller(calls, () => page(SMALL)), { ignoreRobotsTxt: true });
    await lax.callTool({ name: 'distill_url', arguments: { url: 'https://b.example/' } });
    expect(calls[0]?.opts?.robots).toBe('respect');
    expect(calls[1]?.opts?.robots).toBe('ignore');
    for (const call of calls) {
      expect(call.opts?.allowPrivate).toBeUndefined();
      expect(call.opts?.allowHosts).toBeUndefined();
    }
  });

  it('passes boosters and rejects unknown arguments for private overrides', async () => {
    const calls: UrlCall[] = [];
    const client = await connect(fakeDistiller(calls, () => page(SMALL)));
    await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', boosters: ['ws'], allowPrivate: true } });
    expect(calls[0]?.opts?.boosters).toEqual(new Set(['ws']));
    expect(calls[0]?.opts?.allowPrivate).toBeUndefined();
  });

  it('reports errors as code: message', async () => {
    const client = await connect(fakeDistiller([], () => new DistillError('forbidden', 'Refused: 169.254.169.254 is a private address')));
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'http://169.254.169.254/' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'forbidden: Refused: 169.254.169.254 is a private address' }]);
  });

  it('reports needs_javascript', async () => {
    const client = await connect(fakeDistiller([], () => new DistillError('needs_javascript', 'This page needs JavaScript')));
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://app.example.com/' } });
    expect(result.content).toEqual([{ type: 'text', text: 'needs_javascript: This page needs JavaScript' }]);
  });

  it('rejects section together with offset', async () => {
    const client = await connect(fakeDistiller([], () => page(SMALL)));
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', section: 'Guide', offset: 2 } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'bad_request: Pass either section or offset, not both' }]);
  });
});

describe('distill_url mode', () => {
  it('tells the model how to recover missing content', async () => {
    const client = await connect(fakeDistiller([], () => page(SMALL)));
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'distill_url')?.description ?? '';
    expect(description).toContain("If something seems missing (version notes, sidebars, metadata), call again with mode: 'full'");
  });

  it('passes mode through and keeps clean and full copies apart', async () => {
    const calls: UrlCall[] = [];
    const client = await connect(fakeDistiller(calls, () => page(SMALL)));
    await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', mode: 'full' } });
    await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', mode: 'full' } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.opts?.mode).toBeUndefined();
    expect(calls[1]?.opts?.mode).toBe('full');
  });

  it('rejects an unknown mode', async () => {
    const client = await connect(fakeDistiller([], () => page(SMALL)));
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', mode: 'weird' } });
    expect(result.isError).toBe(true);
  });
});

describe('distill_url paging', () => {
  const LONG = `<!-- distill: x -->\n\n# Big guide\n\n${Array.from({ length: 60 }, (_, i) => `## Part ${i + 1}\n\n${`Line of text for part ${i + 1}.\n`.repeat(6)}`).join('\n')}`;

  it('returns the first page with an outline and a continuation, naming distill_url', async () => {
    const client = await connect(fakeDistiller([], () => page(LONG)), { maxResultTokens: 400 });
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    const sc = result.structuredContent as { continuation: string; nextOffset: number; outline: string; lines: { to: number; total: number } };
    expect(sc.continuation).toContain('Call distill_url again with offset');
    expect(sc.nextOffset).toBe(sc.lines.to + 1);
    expect(sc.outline).toContain('Part 1');
    expect(sc.outline).toContain('Part 60');
  });

  it('reads one section by heading', async () => {
    const client = await connect(fakeDistiller([], () => page(LONG)), { maxResultTokens: 5000 });
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', section: 'Part 7' } });
    const md = (result.structuredContent as { markdown: string }).markdown;
    expect(md).toContain('## Part 7');
    expect(md).toContain('Line of text for part 7.');
    expect(md).not.toContain('## Part 8');
    expect((result.structuredContent as { savings?: unknown }).savings).toBeUndefined();
  });

  it('follows nextOffset without fetching again and reports savings once', async () => {
    const calls: UrlCall[] = [];
    const client = await connect(fakeDistiller(calls, () => page(LONG)), { maxResultTokens: 400 });
    const first = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    const next = (first.structuredContent as { nextOffset: number }).nextOffset;
    const second = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', offset: next } });
    expect(calls).toHaveLength(1);
    expect((first.structuredContent as { savings?: unknown }).savings).toBeDefined();
    expect((second.structuredContent as { savings?: unknown }).savings).toBeUndefined();
    expect((second.structuredContent as { lines: { from: number } }).lines.from).toBe(next);
  });

  it('refetches after the in-memory copy goes stale and does not repeat the savings note', async () => {
    const calls: UrlCall[] = [];
    let clock = 1_000_000;
    const client = await connect(fakeDistiller(calls, () => page(SMALL)), { now: () => clock });
    const first = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    clock += 6 * 60 * 1000;
    const second = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    expect(calls).toHaveLength(2);
    expect((first.structuredContent as { savings?: unknown }).savings).toBeDefined();
    expect((second.structuredContent as { savings?: unknown }).savings).toBeUndefined();
  });

  it('records usage once as HTML', async () => {
    const recorded: { kind: string; savings: unknown }[] = [];
    const client = await connect(fakeDistiller([], () => page(SMALL)), { recordUsage: (kind, savings) => recorded.push({ kind, savings }) });
    await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    expect(recorded).toEqual([{ kind: 'HTML', savings: SAVINGS }]);
  });

  it('omits the note when savings notes are off', async () => {
    const client = await connect(fakeDistiller([], () => page(SMALL)), { savingsNote: false });
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/' } });
    expect(result.content).toEqual([{ type: 'text', text: SMALL }]);
  });
});

describe('distill_url sections on a big API page', () => {
  const API = `<!-- distill: x -->\n\n# File system\n\n${Array.from({ length: 300 }, (_, i) => `#### \`fs.method${i}(path[, options], callback)\`\n\nAdded in: v${i}.0.0\n`).join('\n')}`;

  it('finds a deep heading that the capped outline leaves out', async () => {
    const client = await connect(fakeDistiller([], () => page(API)), { maxResultTokens: 5000 });
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', section: 'fs.method250(' } });
    expect(result.isError).toBeFalsy();
    const md = (result.structuredContent as { markdown: string }).markdown;
    expect(md).toContain('#### `fs.method250(path[, options], callback)`');
    expect(md).toContain('Added in: v250.0.0');
    expect(md).not.toContain('fs.method251');
  });

  it('suggests close headings when nothing matches', async () => {
    const client = await connect(fakeDistiller([], () => page(API)));
    const result = await client.callTool({ name: 'distill_url', arguments: { url: 'https://a.example/', section: 'fs.methodX options' } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('No section matches "fs.methodX options". Closest headings: "fs.method0(path[, options], callback)"');
    expect(text.split('"; "')).toHaveLength(5);
    expect(text).toContain('outline of the first read');
  });
});
