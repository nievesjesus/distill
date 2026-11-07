import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');

describe('check-lock', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'distill-check-lock-'));
    mkdirSync(join(sandbox, 'lingua-runtime'));
    cpSync(join(repo, 'package.json'), join(sandbox, 'package.json'));
    cpSync(join(repo, 'package-lock.json'), join(sandbox, 'package-lock.json'));
    cpSync(join(repo, 'lingua-runtime', 'package.json'), join(sandbox, 'lingua-runtime', 'package.json'));
    cpSync(join(repo, 'lingua-runtime', 'package-lock.json'), join(sandbox, 'lingua-runtime', 'package-lock.json'));
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  function run() {
    return spawnSync(process.execPath, [join(repo, 'scripts', 'check-lock.mjs'), sandbox], { encoding: 'utf8' });
  }

  function editRootManifest(edit: (manifest: { devDependencies: Record<string, string> }) => void) {
    const path = join(sandbox, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }

  it('passes on the repository lockfiles', () => {
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each(['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'])('fails when the root pin of %s drifts from lingua-runtime', (name) => {
    editRootManifest((manifest) => {
      manifest.devDependencies[name] = '0.0.1';
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain('lingua-runtime');
  });

  it('fails when a root pin is missing', () => {
    editRootManifest((manifest) => {
      delete manifest.devDependencies['js-tiktoken'];
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('js-tiktoken');
  });
});
