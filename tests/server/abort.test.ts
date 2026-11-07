import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

describe('node server request signal', () => {
  it('aborts c.req.raw.signal when the client disconnects mid-request', async () => {
    let seen: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Hono();
    app.post('/slow', async (c) => {
      await c.req.formData();
      seen = c.req.raw.signal;
      await gate;
      return c.json({ aborted: c.req.raw.signal.aborted });
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const form = new FormData();
    form.append('file', new File(['x'], 'a.pdf'));
    const pending = fetch(`http://127.0.0.1:${port}/slow`, { method: 'POST', body: form, signal: controller.signal }).catch(() => undefined);
    while (!seen) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const aborted = seen.aborted;
    release();
    server.close();
    expect(aborted).toBe(true);
  });
});
