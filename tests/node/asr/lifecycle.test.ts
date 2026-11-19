import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRequest } from '../../../src/node/asr/lifecycle';

describe('readRequest', () => {
  it('resolves on the first line and reports when stdin closes later', async () => {
    const stdin = new PassThrough();
    const pending = readRequest<{ a: number }>(stdin);
    stdin.write('{"a":1}\n');
    const { request, closed } = await pending;
    expect(request).toEqual({ a: 1 });
    let isClosed = false;
    void closed.then(() => (isClosed = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(isClosed).toBe(false);
    stdin.end();
    await closed;
  });

  it('still accepts a request closed without a newline', async () => {
    const stdin = new PassThrough();
    const pending = readRequest<{ a: number }>(stdin);
    stdin.end('{"a":2}');
    expect((await pending).request).toEqual({ a: 2 });
  });

  it('handles a request split across chunks', async () => {
    const stdin = new PassThrough();
    const pending = readRequest<{ a: string }>(stdin);
    stdin.write('{"a":"he');
    stdin.write('llo"}\n');
    expect((await pending).request).toEqual({ a: 'hello' });
  });
});

const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!posix)('worker lifetime', () => {
  it('kills the worker and its ffmpeg when the parent process dies', async () => {
    const pidFile = join(dir, 'ffmpeg.pid');
    const fakeFfmpeg = join(dir, 'ffmpeg');
    writeFileSync(fakeFfmpeg, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`);
    chmodSync(fakeFfmpeg, 0o755);
    const input = join(dir, 'a.mp3');
    writeFileSync(input, 'x');
    const harness = join(process.cwd(), 'tests/node/asr/fixtures/bound-worker.ts');
    const parent = join(dir, 'parent.mjs');
    writeFileSync(
      parent,
      `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(harness)}], { cwd: ${JSON.stringify(process.cwd())}, stdio: ['pipe', 'inherit', 'inherit'] });
writeFileSync(${JSON.stringify(join(dir, 'worker.pid'))}, String(child.pid));
child.stdin.write(JSON.stringify({ input: ${JSON.stringify(input)}, ffmpeg: ${JSON.stringify(fakeFfmpeg)} }) + '\\n');
const wait = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(wait); process.exit(0); } }, 20);
`,
    );
    const p = spawn(process.execPath, [parent], { stdio: 'ignore' });
    await new Promise((r) => p.once('close', r));
    const workerPid = Number(readFileSync(join(dir, 'worker.pid'), 'utf8'));
    const ffmpegPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(existsSync(pidFile)).toBe(true);
    await until(() => !alive(workerPid) && !alive(ffmpegPid));
    expect(alive(workerPid)).toBe(false);
    expect(alive(ffmpegPid)).toBe(false);
  }, 20000);
});
