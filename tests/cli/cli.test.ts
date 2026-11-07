import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

describe('distill-llm binary', () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, [join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js')], { cwd: root, encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
  }, 120_000);

  it('serves /api/health on an ephemeral port and exits on SIGTERM', async () => {
    const child = spawn(process.execPath, ['dist/cli.js', '--port', '0', '--no-open'], { cwd: root });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const match = /distill running at (\S+)/.exec(out);
          if (match) resolve(match[1]);
        });
        child.once('exit', () => reject(new Error(`exited early: ${out} ${stderr}`)));
      });
      const res = await fetch(`${url}/api/health`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { version: string }).version).toBe(version);
    } finally {
      child.kill('SIGTERM');
    }
    const code = await exited;
    if (process.platform !== 'win32') expect(code).toBe(0);
  }, 30_000);
});
