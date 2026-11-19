import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = () => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', 'fetch-doc.mjs')).href);

const body = Buffer.from('%PDF-1.4 hello bench');
const sha = createHash('sha256').update(body).digest('hex');

let server: Server;
let base: string;
let dir: string;
let hits: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'distill-bench-fetch-'));
  hits = 0;
  server = createServer((req, res) => {
    hits += 1;
    if (req.url === '/ok.pdf') {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    } else if (req.url === '/big.pdf') {
      res.writeHead(200);
      res.end(Buffer.alloc(2048));
    } else if (req.url === '/hang.pdf') {
      res.writeHead(200);
      res.write('x');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
});

const entry = (path: string, over: Record<string, unknown> = {}) => ({ id: 'doc', url: `${base}${path}`, sha256: sha, ext: 'pdf', ...over });

describe('fetchDoc', () => {
  it('downloads, verifies the hash and is idempotent', async () => {
    const { fetchDoc } = await load();
    const first = await fetchDoc(entry('/ok.pdf'), dir);
    expect(first.status).toBe('downloaded');
    expect(readFileSync(join(dir, 'doc.pdf'))).toEqual(body);
    const second = await fetchDoc(entry('/ok.pdf'), dir);
    expect(second.status).toBe('cached');
    expect(hits).toBe(1);
  });

  it('rejects a sha256 mismatch and leaves nothing behind', async () => {
    const { fetchDoc } = await load();
    const result = await fetchDoc(entry('/ok.pdf', { sha256: 'f'.repeat(64) }), dir);
    expect(result.status).toBe('error');
    expect(result.error).toContain('sha256 mismatch');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('replaces a cached file whose hash no longer matches', async () => {
    const { fetchDoc } = await load();
    writeFileSync(join(dir, 'doc.pdf'), 'stale');
    const result = await fetchDoc(entry('/ok.pdf'), dir);
    expect(result.status).toBe('downloaded');
    expect(readFileSync(join(dir, 'doc.pdf'))).toEqual(body);
  });

  it('reports HTTP errors', async () => {
    const { fetchDoc } = await load();
    const result = await fetchDoc(entry('/missing.pdf'), dir);
    expect(result).toMatchObject({ status: 'error', error: 'HTTP 404' });
  });

  it('enforces the size cap', async () => {
    const { fetchDoc } = await load();
    const result = await fetchDoc(entry('/big.pdf'), dir, { maxBytes: 1024 });
    expect(result.status).toBe('error');
    expect(result.error).toContain('larger than');
    expect(existsSync(join(dir, 'doc.pdf'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('times out', async () => {
    const { fetchDoc } = await load();
    const result = await fetchDoc(entry('/hang.pdf'), dir, { timeoutMs: 150 });
    expect(result.status).toBe('error');
    expect(result.error).toContain('timeout');
    expect(readdirSync(dir)).toEqual([]);
  });
});
