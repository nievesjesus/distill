import type { Readable } from 'node:stream';

export interface WorkerInput<T> {
  request: T;
  closed: Promise<void>;
}

export function readRequest<T>(stdin: Readable): Promise<WorkerInput<T>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((done) => {
      markClosed = done;
    });
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      try {
        resolve({ request: JSON.parse(text) as T, closed });
      } catch (error) {
        reject(error);
      }
    };
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      if (settled) return;
      raw += chunk;
      const at = raw.indexOf('\n');
      if (at >= 0) finish(raw.slice(0, at));
    });
    const end = () => {
      finish(raw);
      markClosed();
    };
    stdin.once('end', end);
    stdin.once('close', end);
    stdin.once('error', end);
  });
}

export function bindToParent(closed: Promise<void>, controller: AbortController, exit: (code: number) => void = (code) => process.exit(code)): void {
  void closed.then(() => {
    controller.abort();
    exit(143);
  });
}
