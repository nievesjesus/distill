import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createGlobalUpdater } from '../../src/node/update-install';

interface Call {
  command: string;
  args: string[];
}

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

function fakeSpawn(reply: (args: string[]) => Reply) {
  const calls: Call[] = [];
  const spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const out = reply(args);
    setImmediate(() => {
      if (out.stdout) child.stdout.emit('data', Buffer.from(out.stdout));
      if (out.stderr) child.stderr.emit('data', Buffer.from(out.stderr));
      child.emit('close', out.code ?? 0);
    });
    return child as unknown as ChildProcess;
  }) as never;
  return { spawn, calls };
}

const npm = async () => ({ command: 'npm', prefixArgs: ['cli.js'] });
const identity = async (p: string) => p;

function setup(packageRoot: string, installReply: Reply = {}) {
  const fake = fakeSpawn((args) => (args.includes('root') ? { stdout: '/usr/local/lib/node_modules\n' } : installReply));
  const updater = createGlobalUpdater({ packageRoot, spawn: fake.spawn, findNpm: npm, realpath: identity });
  return { updater, calls: fake.calls };
}

describe('createGlobalUpdater', () => {
  it('starts idle', () => {
    expect(setup('/x').updater.status()).toEqual({ state: 'idle' });
  });

  it('refuses a project-local install', async () => {
    const { updater, calls } = setup('/proj/node_modules/distill-llm');
    await updater.install('0.2.0');
    const status = updater.status();
    expect(status.state).toBe('failed');
    expect(status.error).toBe('distill-llm is not installed globally with npm. Update it the way you installed it.');
    expect(calls.some((c) => c.args.includes('install'))).toBe(false);
  });

  it('installs the exact version', async () => {
    const { updater, calls } = setup('/usr/local/lib/node_modules/distill-llm');
    await updater.install('0.2.0');
    expect(calls[calls.length - 1]!.args.slice(-3)).toEqual(['install', '-g', 'distill-llm@0.2.0']);
    expect(updater.status()).toEqual({ state: 'done', version: '0.2.0' });
  });

  it('rejects a bad version', async () => {
    const { updater, calls } = setup('/usr/local/lib/node_modules/distill-llm');
    await updater.install('latest');
    expect(updater.status().state).toBe('failed');
    expect(updater.status().error).toBe('Invalid version');
    expect(calls).toHaveLength(0);
  });

  it('does not run twice', async () => {
    const { updater, calls } = setup('/usr/local/lib/node_modules/distill-llm');
    const first = updater.install('0.2.0');
    const second = updater.install('0.2.0');
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(calls.filter((c) => c.args.includes('install'))).toHaveLength(1);
  });

  it('reports npm errors', async () => {
    const { updater } = setup('/usr/local/lib/node_modules/distill-llm', { stderr: 'EACCES: permission denied', code: 1 });
    await updater.install('0.2.0');
    expect(updater.status().state).toBe('failed');
    expect(updater.status().error).toContain('EACCES');
  });

  it('reports a missing npm', async () => {
    const updater = createGlobalUpdater({ packageRoot: '/x', findNpm: async () => undefined, realpath: identity });
    await updater.install('0.2.0');
    expect(updater.status()).toEqual({ state: 'failed', version: '0.2.0', error: 'npm was not found on PATH' });
  });

  it('can run again after finishing', async () => {
    const { updater, calls } = setup('/usr/local/lib/node_modules/distill-llm');
    await updater.install('0.2.0');
    await updater.install('0.3.0');
    expect(calls.filter((c) => c.args.includes('install'))).toHaveLength(2);
    expect(updater.status()).toEqual({ state: 'done', version: '0.3.0' });
  });
});
