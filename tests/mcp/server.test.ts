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
    distillUrl: async () => { throw new Error('unused'); },
    renderPage: async () => ({ image: Buffer.from('PNGDATA'), mimeType: 'image/png', width: 850, height: 1100 }),
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
  recordUsage?: (kind: string, savings: unknown) => void;
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
    distillUrl: async () => { throw new Error('unused'); },
    renderPage: async () => ({ image: Buffer.from('PNGDATA'), mimeType: 'image/png', width: 850, height: 1100 }),
    health: () => HEALTH,
    close: () => {},
  };
}

const fixedStat = async () => ({ size: 1, mtimeMs: 1 });

async function connect(deps: ConnectDeps = {}) {
  const server = createMcpServer({
    distiller: deps.distiller ?? fakeDistiller(),
    health: () => deps.distiller?.health() ?? HEALTH,
    resolvePath: deps.resolvePath ?? (async (p) => p),
    ...(deps.savingsNote === undefined ? {} : { savingsNote: deps.savingsNote }),
    ...(deps.maxResultTokens === undefined ? {} : { maxResultTokens: deps.maxResultTokens }),
    ...(deps.stat === undefined ? {} : { stat: deps.stat }),
    ...(deps.recordUsage === undefined ? {} : { recordUsage: deps.recordUsage }),
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
  it('lists the seven tools, all read-only with a title', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['distill_capabilities', 'distill_file', 'distill_files', 'distill_outline', 'distill_page_image', 'distill_search', 'distill_url']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: tool.name === 'distill_url' || tool.name === 'distill_search' });
      expect(tool.title?.length).toBeGreaterThan(0);
    }
  });

  it('describes the real limits and routes between tools', async () => {
    const client = await connect({ maxResultTokens: 7777 });
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';
    expect(description('distill_file')).toContain('7777');
    expect(description('distill_file')).toContain('distill_outline');
    expect(description('distill_file')).toContain('1 KB');
    expect(description('distill_outline')).toContain('distill_file');
    expect(description('distill_files')).toContain('distill_file');
    expect(description('distill_file')).toContain('visualPages');
    expect(description('distill_outline')).toContain('visualPages');
    expect(description('distill_page_image')).toContain('visualPages');
  });

  describe('visual pages', () => {
    const visual = [{ page: 2, label: 'ii', kind: 'figure' as const }];
    const withVisual = (): Distiller => ({
      ...fakeDistiller(),
      async distillFile(path) {
        const name = path.split('/').pop() as string;
        return { path, name, kind: 'PDF', pages: 2, markdown: `# ${name}\n`, tokens: { raw: 100, out: 60 }, ms: 5, visualPages: visual };
      },
    });

    it('distill_file reports visualPages on the first page of a read', async () => {
      const client = await connect({ distiller: withVisual() });
      const first = await client.callTool({ name: 'distill_file', arguments: { path: '/x/doc.pdf' } });
      expect((first.structuredContent as { visualPages?: unknown }).visualPages).toEqual(visual);
      const later = await client.callTool({ name: 'distill_file', arguments: { path: '/x/doc.pdf', offset: 1, limit: 1 } });
      expect((later.structuredContent as { visualPages?: unknown }).visualPages).toBeUndefined();
    });

    it('distill_outline reports visualPages', async () => {
      const client = await connect({ distiller: withVisual() });
      const result = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/doc.pdf' } });
      expect((result.structuredContent as { visualPages?: unknown }).visualPages).toEqual(visual);
    });

    it('describes page numbers as physical', async () => {
      const client = await connect();
      const tools = (await client.listTools()).tools;
      const text = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';
      expect(text('distill_page_image')).toContain('physical page number, 1-based, as listed in visualPages.page');
      expect(text('distill_file')).toContain('physical page number');
      expect(text('distill_outline')).toContain('label');
    });

    it('omits visualPages when there are none', async () => {
      const client = await connect();
      const result = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/doc.pdf' } });
      expect(Object.keys(result.structuredContent as object)).not.toContain('visualPages');
    });
  });

  describe('distill_page_image', () => {
    it('returns the page as an image block with sizes and no bytes in structuredContent', async () => {
      const client = await connect();
      const result = await client.callTool({ name: 'distill_page_image', arguments: { path: '/x/doc.pdf', page: 2 } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' }]);
      expect(result.structuredContent).toEqual({ page: 2, width: 850, height: 1100, bytes: 7 });
    });

    it('resolves the path with the shared rules', async () => {
      const seen: string[] = [];
      const distiller = { ...fakeDistiller(), renderPage: async (path: string) => { seen.push(path); return { image: Buffer.from('x'), mimeType: 'image/png' }; } };
      const client = await connect({ distiller, resolvePath: async (p) => `/root/${p}` });
      const result = await client.callTool({ name: 'distill_page_image', arguments: { path: 'doc.pdf', page: 1 } });
      expect(seen).toEqual(['/root/doc.pdf']);
      expect(result.structuredContent).toEqual({ page: 1, bytes: 1 });
    });

    it('reports errors with their code', async () => {
      const distiller = { ...fakeDistiller(), renderPage: async () => { throw new DistillError('bad_request', 'Only PDFs and images can be shown'); } };
      const client = await connect({ distiller });
      const result = await client.callTool({ name: 'distill_page_image', arguments: { path: '/x/a.docx', page: 1 } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'bad_request: Only PDFs and images can be shown' }]);
    });

    it('rejects a page below 1', async () => {
      const client = await connect();
      const result = await client.callTool({ name: 'distill_page_image', arguments: { path: '/x/doc.pdf', page: 0 } }).catch((e: unknown) => ({ isError: true, e }));
      expect(result.isError).toBe(true);
    });
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
    expect(result.structuredContent).toEqual({ ...HEALTH, maxResultTokens: 10000 });
  });
});

describe('asr capability', () => {
  it('distill_capabilities passes the asr status through', async () => {
    const asr = { installed: false, runtime: true, models: false, ffmpeg: '/usr/bin/ffmpeg', installable: true, diskBytes: 123 };
    const distiller = { ...fakeDistiller(), health: () => ({ ...HEALTH, asr }) };
    const client = await connect({ distiller });
    const result = await client.callTool({ name: 'distill_capabilities', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { asr: unknown }).asr).toEqual(asr);
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
    expect(Object.keys(data)).toEqual(['continuation', 'note', 'kind', 'pages', 'lines', 'nextOffset', 'tokens', 'savings', 'outline', 'markdown']);
    expect(data.outline).toContain('Index of big.pdf: 26 lines');
    expect(result.content).toEqual([
      { type: 'text', text: data.continuation },
      { type: 'text', text: data.outline },
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
      distillUrl: async () => { throw new Error('unused'); },
      renderPage: async () => { throw new Error('unused'); },
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

describe('outline and sections', () => {
  const DOC = ['# Intro', 'intro line', '## Alpha', 'alpha 1', 'alpha 2', '## Beta', 'beta 1', ''].join('\n');
  const docDistiller = (markdown: string): Distiller => ({
    distillUrl: async () => { throw new Error('unused'); },
    renderPage: async () => { throw new Error('unused'); },
    async distillFile(path) {
      return { path, name: 'doc.pdf', kind: 'PDF', pages: 3, markdown, tokens: { raw: 100, out: 60 }, ms: 1 };
    },
    health: () => HEALTH,
    close: () => {},
  });
  const file = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'distill_file', arguments: { path: '/x/doc.pdf', ...args } });
  type Structured = Record<string, unknown>;

  it('distill_outline returns the rendered index and the structured entries in order', async () => {
    const client = await connect({ distiller: docDistiller(DOC) });
    const result = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/doc.pdf' } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Structured;
    const savings = estimateSavings({ kind: 'PDF', pages: 3, tokens: { raw: 100, out: 60 } });
    expect(Object.keys(data)).toEqual(['note', 'outline', 'kind', 'pages', 'lines', 'tokens', 'entries']);
    expect(data.note).toBe(savingsNote(savings));
    expect(data.outline).toContain('Index of doc.pdf: 8 lines');
    expect(data.kind).toBe('PDF');
    expect(data.pages).toBe(3);
    expect(data.lines).toBe(8);
    expect(data.tokens).toBe(countTokens(DOC));
    expect((data.entries as { title: string; line: number; endLine: number }[]).map((e) => [e.title, e.line, e.endLine])).toEqual([
      ['# Intro', 1, 8],
      ['## Alpha', 3, 5],
      ['## Beta', 6, 8],
    ]);
    expect((result.content as { text: string }[])[0]?.text).toBe(data.outline);
  });

  it('distill_outline omits the note when disabled and reports errors', async () => {
    const client = await connect({ distiller: fakeDistiller(), savingsNote: false });
    const ok = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/doc.pdf' } });
    expect(ok.structuredContent).not.toHaveProperty('note');
    const bad = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/bad.pdf' } });
    expect(bad.isError).toBe(true);
    expect(bad.content).toEqual([{ type: 'text', text: 'parse_failed: broken file' }]);
  });

  it('section matches a title exactly, ignoring case and hashes', async () => {
    const client = await connect({ distiller: docDistiller(DOC) });
    const data = (await file(client, { section: 'ALPHA' })).structuredContent as Structured;
    expect(data.markdown).toBe('## Alpha\nalpha 1\nalpha 2\n');
    expect(data.lines).toEqual({ from: 3, to: 5, total: 7 });
    expect(data).not.toHaveProperty('nextOffset');
    expect(data).not.toHaveProperty('outline');
    expect(Object.keys(data).at(-1)).toBe('markdown');
  });

  it('section falls back to the first substring match, clamped to the document', async () => {
    const client = await connect({ distiller: docDistiller(DOC) });
    const data = (await file(client, { section: 'bet' })).structuredContent as Structured;
    expect(data.markdown).toBe('## Beta\nbeta 1\n');
    expect(data.lines).toEqual({ from: 6, to: 7, total: 7 });
  });

  it('prefers an exact title over an earlier substring match', async () => {
    const md = ['# Top', '## Alpha beta', 'x', '## Beta', 'y', ''].join('\n');
    const client = await connect({ distiller: docDistiller(md) });
    const data = (await file(client, { section: 'beta' })).structuredContent as Structured;
    expect(data.markdown).toBe('## Beta\ny\n');
  });

  it('rejects an unknown section and section combined with offset', async () => {
    const client = await connect({ distiller: docDistiller(DOC) });
    const none = await file(client, { section: 'Gamma' });
    expect(none.isError).toBe(true);
    expect(none.content).toEqual([{ type: 'text', text: 'bad_request: No section matches "Gamma". Closest headings: "Intro"; "Alpha"; "Beta". Call distill_outline to list sections.' }]);
    const both = await file(client, { section: 'Alpha', offset: 2 });
    expect(both.isError).toBe(true);
    expect((both.content as { text: string }[])[0]?.text).toMatch(/^bad_request:/);
  });

  it('limit windows the read and paging stays inside the window', async () => {
    const PAGE = LINE_COST * 10;
    const client = await connect({ distiller: bigDistiller({ 'big.pdf': 25 }), maxResultTokens: PAGE });
    const first = (await file(client, { path: '/x/big.pdf', offset: 5, limit: 12 })).structuredContent as Structured;
    expect(first.lines).toEqual({ from: 5, to: 14, total: 25 });
    expect(first.nextOffset).toBe(15);
    expect(first.continuation).toBe('Showing lines 5-14 of 25. Call distill_file again with offset 15 and limit 2 to continue.');
    expect(first).not.toHaveProperty('outline');
    const second = (await file(client, { path: '/x/big.pdf', offset: 15, limit: 2 })).structuredContent as Structured;
    expect(second.lines).toEqual({ from: 15, to: 16, total: 25 });
    expect(second).not.toHaveProperty('nextOffset');
    expect(second).not.toHaveProperty('continuation');
    const fromStart = (await file(client, { path: '/x/big.pdf', limit: 3 })).structuredContent as Structured;
    expect(fromStart.lines).toEqual({ from: 1, to: 3, total: 25 });
    expect(fromStart).not.toHaveProperty('savings');
    expect(fromStart).not.toHaveProperty('note');
    expect(fromStart).not.toHaveProperty('outline');
  });

  it('adds the outline only to a partial first page without offset, limit or section', async () => {
    const PAGE = LINE_COST * 10;
    const client = await connect({ distiller: bigDistiller({ 'big.pdf': 25 }), maxResultTokens: PAGE });
    const first = (await file(client, { path: '/x/big.pdf' })).structuredContent as Structured;
    expect(first.outline).toContain('Index of big.pdf');
    const later = (await file(client, { path: '/x/big.pdf', offset: 11 })).structuredContent as Structured;
    expect(later).not.toHaveProperty('outline');
    const whole = (await file(client, { path: '/x/big.pdf', offset: 1, limit: 25 })).structuredContent as Structured;
    expect(whole).not.toHaveProperty('outline');
    const small = (await file(client, {})).structuredContent as Structured;
    expect(small).not.toHaveProperty('outline');
  });
});

describe('usage recording', () => {
  it('records distill_file only from the start without limit or section', async () => {
    const recorded: unknown[][] = [];
    const client = await connect({ recordUsage: (...args) => recorded.push(args), stat: fixedStat });
    await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
    await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf', offset: 2 } });
    await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf', offset: 1, limit: 1 } });
    await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf', limit: 1 } });
    await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf', section: 'a.pdf' } });
    expect(recorded).toEqual([['PDF', SAVINGS]]);
  });

  it('records distill_outline once, even with the note disabled', async () => {
    const recorded: unknown[][] = [];
    const client = await connect({ recordUsage: (...args) => recorded.push(args), stat: fixedStat });
    await client.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
    expect(recorded).toEqual([['PDF', SAVINGS]]);
    const quiet: unknown[][] = [];
    const silent = await connect({ recordUsage: (...args) => quiet.push(args), stat: fixedStat, savingsNote: false });
    await silent.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
    expect(quiet).toEqual([['PDF', SAVINGS]]);
  });

  it('records each distill_files result', async () => {
    const recorded: unknown[][] = [];
    const client = await connect({ recordUsage: (...args) => recorded.push(args), stat: fixedStat });
    await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/bad.pdf', '/x/a.pdf', '/x/b.pdf'] } });
    expect(recorded).toEqual([['PDF', SAVINGS], ['PDF', SAVINGS]]);
  });

  describe('once per document', () => {
    type Data = { note?: string; savings?: unknown };
    const setup = async (stat: (p: string) => Promise<{ size: number; mtimeMs: number }> = fixedStat) => {
      const recorded: unknown[][] = [];
      const client = await connect({ recordUsage: (...args) => recorded.push(args), stat });
      return { recorded, client };
    };

    it('outline then file reports once', async () => {
      const { recorded, client } = await setup();
      const outline = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
      const file = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
      expect((outline.structuredContent as Data).note).toBe(savingsNote(SAVINGS));
      expect(file.structuredContent).not.toHaveProperty('note');
      expect(file.structuredContent).not.toHaveProperty('savings');
      expect(recorded).toEqual([['PDF', SAVINGS]]);
    });

    it('file then outline reports once', async () => {
      const { recorded, client } = await setup();
      const file = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
      const outline = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
      expect((file.structuredContent as Data).note).toBe(savingsNote(SAVINGS));
      expect(outline.structuredContent).not.toHaveProperty('note');
      expect(recorded).toEqual([['PDF', SAVINGS]]);
    });

    it('a second distill_file has no note', async () => {
      const { recorded, client } = await setup();
      await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
      const second = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
      expect(second.structuredContent).not.toHaveProperty('note');
      expect(second.structuredContent).not.toHaveProperty('savings');
      expect(recorded).toHaveLength(1);
    });

    it('a partial read does not consume the report', async () => {
      const { recorded, client } = await setup();
      await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf', offset: 1, limit: 1 } });
      const full = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
      expect((full.structuredContent as Data).note).toBe(savingsNote(SAVINGS));
      expect(recorded).toHaveLength(1);
    });

    it('different documents each get their note', async () => {
      const { recorded, client } = await setup();
      const a = await client.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
      const b = await client.callTool({ name: 'distill_file', arguments: { path: '/x/b.pdf' } });
      expect((a.structuredContent as Data).note).toBeDefined();
      expect((b.structuredContent as Data).note).toBeDefined();
      expect(recorded).toHaveLength(2);
    });

    it('distill_files skips documents already reported', async () => {
      const { recorded, client } = await setup();
      await client.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
      const result = await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/a.pdf', '/x/b.pdf'] } });
      const data = result.structuredContent as { results: { savings?: unknown }[]; total: unknown; note?: string };
      expect(data.results[0]).not.toHaveProperty('savings');
      expect(data.results[1]?.savings).toEqual(SAVINGS);
      expect(data.note).toBe(savingsNote(SAVINGS));
      expect(recorded).toHaveLength(2);
      const again = await client.callTool({ name: 'distill_files', arguments: { paths: ['/x/a.pdf', '/x/b.pdf'] } });
      expect(again.structuredContent).toHaveProperty('total', null);
      expect(again.structuredContent).not.toHaveProperty('note');
      expect(recorded).toHaveLength(2);
    });

    it('keeps reporting when the document cannot be statted', async () => {
      const { recorded, client } = await setup(async () => {
        throw new Error('gone');
      });
      await client.callTool({ name: 'distill_outline', arguments: { path: '/x/a.pdf' } });
      const file = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
      expect((file.structuredContent as Data).note).toBe(savingsNote(SAVINGS));
      expect(recorded).toHaveLength(2);
    });
  });

  it('does not break the call when recording throws', async () => {
    const client = await connect({
      recordUsage: () => {
        throw new Error('disk full');
      },
    });
    const result = await client.callTool({ name: 'distill_file', arguments: { path: '/x/a.pdf' } });
    expect(result.isError).toBeFalsy();
  });
});
