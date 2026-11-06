import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Health } from '../../src/core/types';
import { startServer } from '../../src/server/start';

describe('startServer', () => {
  it('serves /api/health on port 0 and closes', async () => {
    const server = await startServer({ port: 0, host: '127.0.0.1', maxBytes: 1234 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.url).not.toMatch(/:0$/);
      const res = await fetch(`${server.url}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Health;
      expect(body.maxBytes).toBe(1234);
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(body.liteparseVersion).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await server.close();
    }
  });

  it('rejects with EADDRINUSE when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(startServer({ port, host: '127.0.0.1', maxBytes: 10 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
