import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const script = join(repo, 'scripts', 'sync-versions.mjs');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

interface Tool {
  syncVersions: (root: string) => string[];
}

const load = async (): Promise<Tool> => import(/* @vite-ignore */ pathToFileURL(script).href);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-sync-'));
  mkdirSync(join(dir, 'plugins', 'distill', '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'distill-llm', version: '1.2.3' }, null, 2) + '\n');
  writeFileSync(
    join(dir, 'server.json'),
    JSON.stringify({ name: 'x', version: '0.0.1', packages: [{ identifier: 'distill-llm', version: '0.0.1' }] }, null, 2) + '\n',
  );
  writeFileSync(join(dir, 'plugins', 'distill', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'distill', version: '0.0.1' }, null, 2) + '\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('syncVersions', () => {
  it('sets every version to the package version and reports the changed files', async () => {
    const { syncVersions } = await load();
    const changed = syncVersions(dir);
    expect(changed.sort()).toEqual(['plugins/distill/.claude-plugin/plugin.json', 'server.json']);
    const server = readJson(join(dir, 'server.json'));
    expect(server.version).toBe('1.2.3');
    expect(server.packages[0].version).toBe('1.2.3');
    expect(readJson(join(dir, 'plugins', 'distill', '.claude-plugin', 'plugin.json')).version).toBe('1.2.3');
    expect(readFileSync(join(dir, 'server.json'), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('is idempotent', async () => {
    const { syncVersions } = await load();
    syncVersions(dir);
    expect(syncVersions(dir)).toEqual([]);
  });
});

describe('repository metadata', () => {
  const server = readJson(join(repo, 'server.json'));
  const pkg = readJson(join(repo, 'package.json'));

  it('is in sync with package.json', async () => {
    const { syncVersions } = await load();
    const copy = join(dir, 'repo');
    mkdirSync(join(copy, 'plugins', 'distill', '.claude-plugin'), { recursive: true });
    for (const file of ['package.json', 'server.json', 'plugins/distill/.claude-plugin/plugin.json']) {
      writeFileSync(join(copy, file), readFileSync(join(repo, file), 'utf8'));
    }
    expect(syncVersions(copy)).toEqual([]);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it('names the same server in package.json and server.json', () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.packages[0].identifier).toBe(pkg.name);
  });

  it('keeps the description within the registry limit', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('runs the sync during npm version', () => {
    expect(pkg.scripts.version).toBe('node scripts/sync-versions.mjs');
  });
});
