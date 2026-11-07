import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');

describe('make-signed-config', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'distill-signed-config-'));
    for (const variant of ['lite', 'full']) {
      cpSync(join(repo, `electron-builder.${variant}.yml`), join(sandbox, `electron-builder.${variant}.yml`));
    }
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(variant: string) {
    return spawnSync('node', [join(repo, 'scripts', 'make-signed-config.mjs'), variant], {
      cwd: sandbox,
      encoding: 'utf8',
    });
  }

  for (const variant of ['lite', 'full']) {
    it(`signs the dmg and keeps the mac entries for ${variant}`, () => {
      expect(run(variant).status).toBe(0);
      const out = readFileSync(join(sandbox, `electron-builder.${variant}.signed.yml`), 'utf8');
      expect(out).toMatch(/^dmg:\n {2}sign: true\n/m);
      expect(out).toContain('  notarize: true');
      expect(out).toContain('  hardenedRuntime: true');
      expect(out).toContain('    target: dmg');
      expect(out).not.toContain('identity: "-"');
    });
  }

  it('merges into an existing dmg block', () => {
    const file = join(sandbox, 'electron-builder.lite.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}dmg:\n  sign: false\n  title: Distill\n`);
    expect(run('lite').status).toBe(0);
    const out = readFileSync(join(sandbox, 'electron-builder.lite.signed.yml'), 'utf8');
    expect(out).toContain('dmg:\n  sign: true\n  title: Distill\n');
    expect(out.match(/sign:/g)).toHaveLength(1);
  });
});
