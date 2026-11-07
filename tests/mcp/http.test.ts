import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Health } from '../../src/core/types';
import { createMcpServer } from '../../src/mcp/server';
import { serveMcpHttp } from '../../src/mcp/http';

const HEALTH: Health = {
  version: '1',
  liteparseVersion: '1',
  libreoffice: false,
  lingua: { installed: false, installable: false, model: 'tinybert', state: 'idle', progress: 0 },
  maxBytes: 1,
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function start(allowedHosts: string[] = []) {
  const server = await serveMcpHttp({
    port: 0,
    host: '127.0.0.1',
    allowedHosts,
    createServer: () =>
      createMcpServer({
        distiller: {
          async distillFile() {
            throw new Error('unused');
          },
          health: () => HEALTH,
          close: () => {},
        },
        health: () => HEALTH,
        resolvePath: async (p) => p,
      }),
  });
  closers.push(server.close);
  return server;
}

function send(url: string, method: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('serveMcpHttp', () => {
  it('reports the mcp url', async () => {
    const server = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('answers initialize over POST', async () => {
    const server = await start();
    const res = await send(server.url, 'POST', { ...MCP_HEADERS, host: new URL(server.url).host }, INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.body).toContain('"serverInfo"');
  });

  it('rejects an unknown host', async () => {
    const server = await start();
    const res = await send(server.url, 'POST', { ...MCP_HEADERS, host: 'evil.example' }, INITIALIZE);
    expect(res.status).toBe(403);
  });

  it('accepts a host listed in allowedHosts', async () => {
    const server = await start(['mcp.example.com']);
    const res = await send(server.url, 'POST', { ...MCP_HEADERS, host: 'mcp.example.com' }, INITIALIZE);
    expect(res.status).toBe(200);
  });

  it('rejects a foreign origin', async () => {
    const server = await start();
    const res = await send(
      server.url,
      'POST',
      { ...MCP_HEADERS, host: new URL(server.url).host, origin: 'https://evil.example' },
      INITIALIZE,
    );
    expect(res.status).toBe(403);
  });

  it('rejects cross-site fetch metadata', async () => {
    const server = await start();
    const res = await send(
      server.url,
      'POST',
      { ...MCP_HEADERS, host: new URL(server.url).host, 'sec-fetch-site': 'cross-site' },
      INITIALIZE,
    );
    expect(res.status).toBe(403);
  });

  it('answers 405 to GET and DELETE', async () => {
    const server = await start();
    const headers = { host: new URL(server.url).host };
    expect((await send(server.url, 'GET', headers)).status).toBe(405);
    expect((await send(server.url, 'DELETE', headers)).status).toBe(405);
  });

  it('answers 404 for other paths', async () => {
    const server = await start();
    const url = server.url.replace('/mcp', '/other');
    expect((await send(url, 'POST', { ...MCP_HEADERS, host: new URL(url).host }, INITIALIZE)).status).toBe(404);
  });

  it('answers 400 to malformed JSON', async () => {
    const server = await start();
    const res = await send(server.url, 'POST', { ...MCP_HEADERS, host: new URL(server.url).host }, '{nope');
    expect(res.status).toBe(400);
  });
});
