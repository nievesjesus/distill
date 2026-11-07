import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hostnameOf, isAllowedHost, isCrossSiteRequest } from '../server/guards';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RangeError('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new SyntaxError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isBlocked(req: IncomingMessage, allowedHosts: readonly string[]): string | null {
  const host = header(req, 'host') ?? '';
  if (!isAllowedHost(hostnameOf(host), allowedHosts)) {
    return 'Request blocked: unknown host. Allow it with --allowed-hosts';
  }
  const origin = header(req, 'origin');
  if (isCrossSiteRequest({ secFetchSite: header(req, 'sec-fetch-site'), origin, host })) {
    return 'Request blocked: cross-site requests are not allowed';
  }
  return null;
}

export async function serveMcpHttp(opts: {
  port: number;
  host: string;
  allowedHosts: string[];
  createServer: () => McpServer;
}): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, 'Internal server error');
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== MCP_PATH) {
      reply(res, 404, 'Not found');
      return;
    }
    const blocked = isBlocked(req, opts.allowedHosts);
    if (blocked !== null) {
      reply(res, 403, blocked);
      return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, 'Method not allowed', { allow: 'POST' });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      reply(res, error instanceof RangeError ? 413 : 400, error instanceof Error ? error.message : 'Bad request');
      return;
    }
    const mcp = opts.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
