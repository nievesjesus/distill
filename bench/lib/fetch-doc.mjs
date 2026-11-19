import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { docFileName } from './tasks.mjs';

export const MAX_BYTES = 50 * 1024 * 1024;
export const TIMEOUT_MS = 60_000;

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function fetchDoc(doc, dir, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const fetchFn = options.fetch ?? fetch;
  const target = join(dir, docFileName(doc));
  if ((await exists(target)) && (await sha256File(target)) === doc.sha256) return { id: doc.id, status: 'cached', path: target };
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.part-${process.pid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(doc.url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'distill-bench/1.0' } });
    if (!response.ok || response.body === null) return { id: doc.id, status: 'error', error: `HTTP ${response.status}` };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return { id: doc.id, status: 'error', error: `larger than ${maxBytes} bytes` };
    let received = 0;
    const cap = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) callback(new Error(`larger than ${maxBytes} bytes`));
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), cap, createWriteStream(temp), { signal: controller.signal });
    const actual = await sha256File(temp);
    if (actual !== doc.sha256) {
      await rm(temp, { force: true });
      return { id: doc.id, status: 'error', error: `sha256 mismatch: expected ${doc.sha256}, got ${actual}` };
    }
    await rename(temp, target);
    return { id: doc.id, status: 'downloaded', path: target };
  } catch (error) {
    await rm(temp, { force: true });
    const message = controller.signal.aborted ? `timeout after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    return { id: doc.id, status: 'error', error: message };
  } finally {
    clearTimeout(timer);
  }
}
