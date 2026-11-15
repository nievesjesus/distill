import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const script = join(repo, 'scripts', 'release-tag.mjs');

interface Decision {
  create: boolean;
  tag: string;
  reason: string;
}

interface Tool {
  decideTag: (version: string, tags: string[]) => Decision;
}

describe('release-tag', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-release-tag-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  async function decide(version: string, tags: string[]) {
    const tool = (await import(pathToFileURL(script).href)) as Tool;
    return tool.decideTag(version, tags);
  }

  it('creates a tag for a newer version', async () => {
    expect(await decide('0.2.1', ['v0.1.2', 'v0.2.0'])).toMatchObject({ create: true, tag: 'v0.2.1', reason: 'new release' });
  });

  it('skips a tag that already exists', async () => {
    expect(await decide('0.2.0', ['v0.2.0'])).toMatchObject({ create: false, tag: 'v0.2.0', reason: 'tag exists' });
  });

  it('skips a version older than an existing tag', async () => {
    expect(await decide('0.1.9', ['v0.2.0'])).toMatchObject({ create: false, reason: 'older than v0.2.0' });
  });

  it('compares versions numerically', async () => {
    expect((await decide('0.10.0', ['v0.9.0'])).create).toBe(true);
  });

  it('skips prerelease versions', async () => {
    expect(await decide('0.3.0-beta.1', [])).toMatchObject({ create: false, reason: 'not a release version' });
  });

  it('ignores tags that are not vX.Y.Z', async () => {
    expect((await decide('1.0.0', ['nightly', 'v0.9.9'])).create).toBe(true);
  });

  it('prints the decision and writes GITHUB_OUTPUT', () => {
    const output = join(dir, 'output.txt');
    const result = spawnSync(process.execPath, [script, '0.2.1', 'v0.1.2', 'v0.2.0'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ create: true, tag: 'v0.2.1', reason: 'new release' });
    const text = readFileSync(output, 'utf8');
    expect(text).toContain('create=true\n');
    expect(text).toContain('tag=v0.2.1\n');
  });
});
