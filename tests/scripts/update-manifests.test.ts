import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const script = join(repo, 'scripts', 'update-manifests.mjs');

interface Tool {
  parseManifest: (text: string) => unknown;
  formatManifest: (manifest: unknown) => string;
}

const exeManifest = `version: 0.2.0
files:
  - url: Distill-lite-win-x64.exe
    sha512: stale==
    size: 1
    blockMapSize: 99
    isAdminRightsRequired: true
path: Distill-lite-win-x64.exe
sha512: stale==
releaseDate: '2026-11-14T13:00:00.000Z'
`;

function macManifest(arch: string, version: string, releaseDate: string) {
  return `version: ${version}
files:
  - url: Distill-lite-mac-${arch}.zip
    sha512: zip-${arch}==
    size: 100
    blockMapSize: 10
  - url: Distill-lite-mac-${arch}.dmg
    sha512: dmg-${arch}==
    size: 200
path: Distill-lite-mac-${arch}.zip
sha512: zip-${arch}==
releaseDate: '${releaseDate}'
`;
}

describe('update-manifests', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-manifests-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  function run(...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  }

  it('round-trips through parse and format', async () => {
    const tool = (await import(pathToFileURL(script).href)) as Tool;
    expect(tool.formatManifest(tool.parseManifest(exeManifest))).toBe(exeManifest);
  });

  it('refresh updates sha512 and size of the signed exe', () => {
    const bytes = Buffer.alloc(1024, 7);
    writeFileSync(join(dir, 'Distill-lite-win-x64.exe'), bytes);
    const manifest = join(dir, 'lite.yml');
    writeFileSync(manifest, exeManifest);
    const result = run('refresh', manifest, join(dir, 'Distill-lite-win-x64.exe'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const digest = createHash('sha512').update(bytes).digest('base64');
    const text = readFileSync(manifest, 'utf8');
    expect(text).toContain(`    sha512: ${digest}\n    size: 1024\n`);
    expect(text).toContain(`path: Distill-lite-win-x64.exe\nsha512: ${digest}\n`);
    expect(text).not.toContain('blockMapSize');
    expect(text).toContain('isAdminRightsRequired: true');
  });

  it('refresh fails for an unknown file', () => {
    writeFileSync(join(dir, 'Other.exe'), 'x');
    const manifest = join(dir, 'lite.yml');
    writeFileSync(manifest, exeManifest);
    const result = run('refresh', manifest, join(dir, 'Other.exe'));
    expect(result.status).toBe(1);
  });

  it('merge combines arm64 and x64', () => {
    const arm = join(dir, 'arm.yml');
    const x64 = join(dir, 'x64.yml');
    const out = join(dir, 'out.yml');
    writeFileSync(arm, macManifest('arm64', '0.2.0', '2026-11-14T13:00:00.000Z'));
    writeFileSync(x64, macManifest('x64', '0.2.0', '2026-11-14T14:00:00.000Z'));
    const result = run('merge', out, arm, x64);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text.match(/- url: /g)).toHaveLength(4);
    expect(text).toContain('path: Distill-lite-mac-arm64.zip\nsha512: zip-arm64==\n');
    expect(text).toContain("releaseDate: '2026-11-14T14:00:00.000Z'");
  });

  it('merge refuses mixed versions', () => {
    const a = join(dir, 'a.yml');
    const b = join(dir, 'b.yml');
    writeFileSync(a, macManifest('arm64', '0.2.0', '2026-11-14T13:00:00.000Z'));
    writeFileSync(b, macManifest('x64', '0.3.0', '2026-11-14T13:00:00.000Z'));
    expect(run('merge', join(dir, 'out.yml'), a, b).status).toBe(1);
  });

  it('fails on unsupported syntax with the line number', () => {
    const manifest = join(dir, 'bad.yml');
    writeFileSync(manifest, 'version: 0.2.0\nfiles:\n  - url: a.zip\n    nested:\n      deep: 1\npath: a.zip\n');
    writeFileSync(join(dir, 'a.zip'), 'x');
    const result = run('refresh', manifest, join(dir, 'a.zip'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported manifest syntax at line 4');
  });
});
