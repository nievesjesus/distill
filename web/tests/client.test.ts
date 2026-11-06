import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DistillRequest, DistillResponse } from '../src/worker/distill.worker';

interface FakeWorker {
  posted: DistillRequest[];
  onmessage: ((event: MessageEvent<DistillResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminated: boolean;
  reply: (response: DistillResponse) => void;
  crash: (message: string) => void;
}

const registry = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('../src/worker/distill.worker?worker', () => ({
  default: class {
    posted: DistillRequest[] = [];
    onmessage: ((event: MessageEvent<DistillResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;

    constructor() {
      registry.instances.push(this);
    }

    postMessage(request: DistillRequest) {
      this.posted.push(request);
    }

    terminate() {
      this.terminated = true;
    }

    reply(response: DistillResponse) {
      this.onmessage?.({ data: response } as MessageEvent<DistillResponse>);
    }

    crash(message: string) {
      this.onerror?.({ message } as ErrorEvent);
    }
  },
}));

const workers = () => registry.instances as FakeWorker[];

const okResponse = (id: number, tag: string): DistillResponse => ({ id, ok: true, out: `out-${tag}`, rawTokens: 10, outTokens: 5 });

async function loadClient() {
  vi.resetModules();
  registry.instances.length = 0;
  return import('../src/worker/client');
}

describe('worker client', () => {
  beforeEach(() => {
    registry.instances.length = 0;
  });

  it('resolves concurrent requests with their own results when replies arrive reversed', async () => {
    const { distill } = await loadClient();
    const first = distill('first', ['ws']);
    const second = distill('second', ['ws']);
    const [worker] = workers();
    const [a, b] = worker.posted;
    worker.reply(okResponse(b.id, 'second'));
    worker.reply(okResponse(a.id, 'first'));
    await expect(first).resolves.toMatchObject({ out: 'out-first' });
    await expect(second).resolves.toMatchObject({ out: 'out-second' });
    expect(workers()).toHaveLength(1);
  });

  it('rejects only the request an error reply belongs to', async () => {
    const { distill } = await loadClient();
    const failing = distill('bad', ['ws']);
    const fine = distill('good', ['ws']);
    const [worker] = workers();
    const [bad, good] = worker.posted;
    worker.reply({ id: bad.id, ok: false, message: 'boom' });
    worker.reply(okResponse(good.id, 'good'));
    await expect(failing).rejects.toThrow('boom');
    await expect(fine).resolves.toMatchObject({ out: 'out-good' });
  });

  it('rejects every pending request on worker error and spawns a new worker next time', async () => {
    const { distill } = await loadClient();
    const one = distill('one', ['ws']);
    const two = distill('two', ['ws']);
    const [crashed] = workers();
    crashed.crash('worker died');
    await expect(one).rejects.toThrow('worker died');
    await expect(two).rejects.toThrow('worker died');
    expect(crashed.terminated).toBe(true);

    const next = distill('three', ['ws']);
    expect(workers()).toHaveLength(2);
    const replacement = workers()[1];
    replacement.reply(okResponse(replacement.posted[0].id, 'three'));
    await expect(next).resolves.toMatchObject({ out: 'out-three' });
  });

  it('sends the cached raw token count on a repeated raw string', async () => {
    const { distill } = await loadClient();
    const first = distill('same raw', ['ws']);
    const [worker] = workers();
    expect(worker.posted[0].knownRawTokens).toBeUndefined();
    worker.reply({ id: worker.posted[0].id, ok: true, out: 'x', rawTokens: 42, outTokens: 7 });
    await first;

    const second = distill('same raw', ['tables']);
    expect(worker.posted[1].knownRawTokens).toBe(42);
    worker.reply(okResponse(worker.posted[1].id, 'again'));
    await second;
  });

  it('evicts the oldest cached raw string after 51 distinct ones', async () => {
    const { distill } = await loadClient();
    const probe = distill('raw-0', ['ws']);
    const worker = workers()[0];
    worker.reply({ id: worker.posted[0].id, ok: true, out: 'x', rawTokens: 1, outTokens: 1 });
    await probe;

    for (let index = 1; index <= 50; index++) {
      const pending = distill(`raw-${index}`, ['ws']);
      const request = worker.posted[worker.posted.length - 1];
      worker.reply({ id: request.id, ok: true, out: 'x', rawTokens: index + 1, outTokens: 1 });
      await pending;
    }

    const again = distill('raw-0', ['ws']);
    expect(worker.posted[worker.posted.length - 1].knownRawTokens).toBeUndefined();
    worker.reply(okResponse(worker.posted[worker.posted.length - 1].id, 'zero'));
    await again;

    const recent = distill('raw-50', ['ws']);
    expect(worker.posted[worker.posted.length - 1].knownRawTokens).toBe(51);
    worker.reply(okResponse(worker.posted[worker.posted.length - 1].id, 'fifty'));
    await recent;
  });
});
