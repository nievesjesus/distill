import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Health } from '../../src/core/types';
import type { Distiller } from '../../src/node/distill';
import { DistillError } from '../../src/node/errors';
import { estimateSavings, savingsNote, sumSavings } from '../../src/core/savings';
import { countTokens } from '../../src/core/tokens';
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

const SAVINGS = estimateSavings({ kind: 'PDF', pages: 2, tokens: { raw: 100, out: 60 } });
const clients: Client[] = [];

interface ConnectDeps {
  distiller?: Distiller;
  resolvePath?: (p: string) => Promise<string>;
  savingsNote?: boolean;
  maxResultTokens?: number;
  stat?: (p: string) => Promise<{ size: number; mtimeMs: number }>;
}

const LINE = 'row alpha beta gamma\n';
const LINE_COST = countTokens(LINE);

function bigDistiller(lineCounts: Record<string, number>, calls: string[] = []): Distiller {
  return {
    async distillFile(path) {
      calls.push(path);
      const name = path.split('/').pop() as string;
      const count = lineCounts[name] ?? 1;
      return { path, name, kind: 'PDF', pages: 2, markdown: LINE.repeat(count), tokens: { raw: 100 * count, out: 60 * count }, ms: 5 };
    },
    health: () => HEALTH,
    close: () => {},
  };
}

const fixedStat = async () => ({ size: 1, mtimeMs: 1 });

async function connect(deps: ConnectDeps = {}) {
  const server = createMcpServer({
    distiller: deps.distiller ?? fakeDistiller(),
    health: () => HEALTH,
    resolvePath: deps.resolvePath ?? (async (p) => p),
    ...(deps.savingsNote === undefined ? {} : { savingsNote: deps.savingsNote }),
    ...(deps.maxResultTokens === undefined ? {} : { maxResultTokens: deps.maxResultTokens }),
    ...(deps.stat === undefined ? {} : { stat: deps.stat }),
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
    expect(result.content).toEqual([
      { type: 'text', text: '# doc.pdf\n' },
      { type: 'text', text: savingsNote(SAVINGS) },
    ]);
    expect(result.structuredContent).toEqual({
      markdown: '# doc.pdf\n',
      tokens: { raw: 100, out: 60 },
      pages: 2,
      kind: 'PDF',
      lines: { from: 1, to: 1, total: 1 },
      savings: SAVINGS,
      note: savingsNote(SAVINGS),
    });
    expect(Object.keys(result.structuredContent as object)).toEqual(['note', 'kind', 'pages', 'lines', 'tokens', 'savings', 'markdown']);
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
        { path: '/x/good.pdf', tokens: { raw: 100, out: 60 }, savings: SAVINGS, markdown: '# good.pdf\n' },
      ],
      total: SAVINGS,
      note: savingsNote(SAVINGS),
    });
    const blocks = result.content as { text: string }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toContain('# good.pdf');
    expect(blocks[0]?.text).toContain('parse_failed: broken file');
    expect(blocks[1]?.text).toBe(savingsNote(SAVINGS));
  });

  it('distill_file omits the note when disabled but keeps structured savings', async () => {
    const client = await connect({ savingsNote: false });
    const result = await client.callTool({ name: 'distill_file', arguments: { path: '/x/doc.pdf' } });
    expect(result.content).toEqual([{ type: 'text', text: '# doc.pdf\n' }]);
    expect((result.structuredContent as { savings: unknown }).savings).toEqual(SAVINGS);
    expect(result.structuredContent).not.toHaveProperty('note');
  });

  it('distill_files sums the total in one note and respects the switch', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/a.pdf', '/x/b.pdf'] } });
    const total = estimateSavings({ kind: 'PDF', pages: 4, tokens: { raw: 200, out: 120 } });
    expect((result.structuredContent as { total: unknown }).total).toEqual(total);
    expect((result.content as { text: string }[])[1]?.text).toBe(savingsNote(total));
    const quiet = await (await connect({ savingsNote: false })).callTool({ name: 'distill_files', arguments: { paths: ['/x/a.pdf'] } });
    expect(quiet.content as unknown[]).toHaveLength(1);
    expect(quiet.structuredContent).not.toHaveProperty('note');
    expect((result.structuredContent as { note: unknown }).note).toBe(savingsNote(total));
  });

  it('distill_files has a null total and no note when every file fails', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/bad.pdf'] } });
    expect((result.structuredContent as { total: unknown }).total).toBeNull();
    expect(result.structuredContent).not.toHaveProperty('note');
    expect(result.content as unknown[]).toHaveLength(1);
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

describe('paging', () => {
  const PAGE = LINE_COST * 10;
  const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'distill_file', arguments: args });
  type Structured = Record<string, unknown>;

  it('large documents return page 1 with continuation, nextOffset, note and savings', async () => {
    const client = await connect({ distiller: bigDistiller({ 'big.pdf': 25 }), maxResultTokens: PAGE });
    const result = await call(client, { path: '/x/big.pdf' });
    const data = result.structuredContent as Structured;
    const savings = estimateSavings({ kind: 'PDF', pages: 2, tokens: { raw: 2500, out: 1500 } });
    expect(data.markdown).toBe(LINE.repeat(10));
    expect(data.lines).toEqual({ from: 1, to: 10, total: 25 });
    expect(data.nextOffset).toBe(11);
    expect(data.continuation).toBe('Showing lines 1-10 of 25. Call distill_file again with offset 11 to continue.');
    expect(data.savings).toEqual(savings);
    expect(data.note).toBe(savingsNote(savings));
    expect(Object.keys(data)).toEqual(['continuation', 'note', 'kind', 'pages', 'lines', 'nextOffset', 'tokens', 'savings', 'markdown']);
    expect(result.content).toEqual([
      { type: 'text', text: data.continuation },
      { type: 'text', text: LINE.repeat(10) },
      { type: 'text', text: savingsNote(savings) },
    ]);
  });

  it('later pages omit savings and note, and the last page has no nextOffset or continuation', async () => {
    const client = await connect({ distiller: bigDistiller({ 'big.pdf': 25 }), maxResultTokens: PAGE });
    const second = (await call(client, { path: '/x/big.pdf', offset: 11 })).structuredContent as Structured;
    expect(second.lines).toEqual({ from: 11, to: 20, total: 25 });
    expect(second.nextOffset).toBe(21);
    expect(second.continuation).toBe('Showing lines 11-20 of 25. Call distill_file again with offset 21 to continue.');
    expect(second).not.toHaveProperty('savings');
    expect(second).not.toHaveProperty('note');
    expect(Object.keys(second).at(-1)).toBe('markdown');
    const last = await call(client, { path: '/x/big.pdf', offset: 21 });
    const data = last.structuredContent as Structured;
    expect(data.markdown).toBe(LINE.repeat(5));
    expect(data.lines).toEqual({ from: 21, to: 25, total: 25 });
    expect(data).not.toHaveProperty('nextOffset');
    expect(data).not.toHaveProperty('continuation');
    expect(data).not.toHaveProperty('savings');
    expect(last.content).toEqual([{ type: 'text', text: LINE.repeat(5) }]);
  });

  it('rejects an offset beyond the end', async () => {
    const client = await connect({ distiller: bigDistiller({ 'big.pdf': 25 }), maxResultTokens: PAGE });
    const result = await call(client, { path: '/x/big.pdf', offset: 26 });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'bad_request: offset 26 is beyond the end of the document (25 lines)' }]);
    expect((await call(client, { path: '/x/big.pdf', offset: 0 })).isError).toBe(true);
  });

  it('hard-cuts a single overlong line and flags it', async () => {
    const long = `${'word '.repeat(200)}\nshort\n`;
    const distiller: Distiller = {
      async distillFile(path) {
        return { path, name: 'long.pdf', kind: 'PDF', pages: 1, markdown: long, tokens: { raw: 10, out: 10 }, ms: 1 };
      },
      health: () => HEALTH,
      close: () => {},
    };
    const client = await connect({ distiller, maxResultTokens: 20 });
    const data = (await call(client, { path: '/x/long.pdf' })).structuredContent as Structured;
    expect(data.truncated).toBe(true);
    expect((data.markdown as string).length).toBe(80);
    expect(data.lines).toEqual({ from: 1, to: 1, total: 2 });
    expect(data.nextOffset).toBe(2);
  });

  it('converts once across pages thanks to the cache', async () => {
    const calls: string[] = [];
    const client = await connect({ distiller: bigDistiller({ 'big.pdf': 25 }, calls), maxResultTokens: PAGE, stat: fixedStat });
    await call(client, { path: '/x/big.pdf' });
    await call(client, { path: '/x/big.pdf', offset: 11 });
    await call(client, { path: '/x/big.pdf', offset: 21 });
    expect(calls).toHaveLength(1);
    await call(client, { path: '/x/big.pdf', lingua: true });
    expect(calls).toHaveLength(2);
  });

  it('reconverts when the file changed and when stat fails', async () => {
    const calls: string[] = [];
    let mtimeMs = 1;
    const client = await connect({ distiller: bigDistiller({}, calls), stat: async () => ({ size: 1, mtimeMs }) });
    await call(client, { path: '/x/a.pdf' });
    mtimeMs = 2;
    await call(client, { path: '/x/a.pdf' });
    expect(calls).toHaveLength(2);
    const failing = [] as string[];
    const noStat = await connect({
      distiller: bigDistiller({}, failing),
      stat: async () => {
        throw new Error('gone');
      },
    });
    await call(noStat, { path: '/x/a.pdf' });
    await call(noStat, { path: '/x/a.pdf' });
    expect(failing).toHaveLength(2);
  });

  it('keeps only the last 8 conversions', async () => {
    const calls: string[] = [];
    const client = await connect({ distiller: bigDistiller({}, calls), stat: fixedStat });
    for (let i = 0; i < 9; i++) await call(client, { path: `/x/f${i}.pdf` });
    await call(client, { path: '/x/f8.pdf' });
    expect(calls).toHaveLength(9);
    await call(client, { path: '/x/f0.pdf' });
    expect(calls).toHaveLength(10);
  });

  it('distill_files shares the budget: whole, partial, then skipped without converting', async () => {
    const calls: string[] = [];
    const client = await connect({ distiller: bigDistiller({ 'a.pdf': 6, 'b.pdf': 10, 'c.pdf': 3 }, calls), maxResultTokens: LINE_COST * 10 });
    const result = await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/a.pdf', '/x/b.pdf', '/x/c.pdf'] } });
    const data = result.structuredContent as { results: Structured[]; total: unknown; continuation: string; note: string };
    expect(calls).toEqual(['/x/a.pdf', '/x/b.pdf']);
    const [a, b, c] = data.results as [Structured, Structured, Structured];
    expect(a.markdown).toBe(LINE.repeat(6));
    expect(a).not.toHaveProperty('lines');
    expect(b.markdown).toBe(LINE.repeat(4));
    expect(b.lines).toEqual({ from: 1, to: 4, total: 10 });
    expect(b.nextOffset).toBe(5);
    expect(b.continuation).toBe('Showing lines 1-4 of 10. Call distill_file with this path and offset 5 to continue.');
    expect(Object.keys(b).at(-1)).toBe('markdown');
    expect(c).toEqual({ path: '/x/c.pdf', skipped: true, continuation: 'Not included to stay under the size limit. Call distill_file with this path.' });
    const total = sumSavings([
      estimateSavings({ kind: 'PDF', pages: 2, tokens: { raw: 600, out: 360 } }),
      estimateSavings({ kind: 'PDF', pages: 2, tokens: { raw: 1000, out: 600 } }),
    ]);
    expect(data.total).toEqual(total);
    expect(data.note).toBe(savingsNote(total));
    expect(data.continuation).toContain('1 file(s) returned in part, 1 not included');
    expect(Object.keys(data)[0]).toBe('continuation');
    const blocks = result.content as { text: string }[];
    expect(blocks[0]?.text).toBe(data.continuation);
    expect(blocks[1]?.text).toContain('# c.pdf');
    expect(blocks.at(-1)?.text).toBe(savingsNote(total));
  });

  it('distill_files has no continuation when everything fits', async () => {
    const client = await connect({ distiller: bigDistiller({ 'a.pdf': 2, 'b.pdf': 2 }), maxResultTokens: LINE_COST * 10 });
    const result = await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/a.pdf', '/x/b.pdf'] } });
    expect(result.structuredContent).not.toHaveProperty('continuation');
    expect(result.content as unknown[]).toHaveLength(2);
  });
});
