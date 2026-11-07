import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRoots, rootResolver } from '../../src/mcp/roots';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'distill-roots-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'a.pdf'), 'x');
  writeFileSync(join(outside, 'b.pdf'), 'x');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('rootResolver', () => {
  it('accepts a path inside a root', async () => {
    const resolve = rootResolver([root], root);
    await expect(resolve(join(root, 'a.pdf'))).resolves.toBe(join(root, 'a.pdf'));
  });

  it('resolves relative paths against cwd', async () => {
    const resolve = rootResolver([root], root);
    await expect(resolve('a.pdf')).resolves.toBe(join(root, 'a.pdf'));
  });

  it('rejects traversal outside the roots', async () => {
    const resolve = rootResolver([root], root);
    await expect(resolve('../outside/b.pdf')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Path is outside the allowed roots',
    });
  });

  it('rejects a symlink inside the root that points outside', async () => {
    symlinkSync(outside, join(root, 'link'));
    const resolve = rootResolver([root], root);
    await expect(resolve('link/b.pdf')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('accepts any of several roots', async () => {
    const resolve = rootResolver([root, outside], root);
    await expect(resolve(join(outside, 'b.pdf'))).resolves.toBe(join(outside, 'b.pdf'));
  });

  it('rejects a sibling directory sharing the root prefix', async () => {
    const sibling = join(base, 'root-evil');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'c.pdf'), 'x');
    const resolve = rootResolver([root], root);
    await expect(resolve(join(sibling, 'c.pdf'))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports a missing file as not_found', async () => {
    const resolve = rootResolver([root], root);
    await expect(resolve('missing.pdf')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rootResolver existence oracle and missing roots', () => {
  it('answers forbidden for a missing file outside the roots', async () => {
    const resolve = rootResolver([root], root);
    await expect(resolve(join(outside, 'nope.pdf'))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('answers not_found for a missing file inside the roots', async () => {
    const resolve = rootResolver([root], root);
    await expect(resolve(join(root, 'nope.pdf'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not leave an unhandled rejection for a missing root', async () => {
    const resolve = rootResolver([join(base, 'missing-root')], root);
    await expect(resolve(join(root, 'a.pdf'))).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('Root not found') });
  });

  it('resolveRoots rejects a missing root', async () => {
    await expect(resolveRoots([join(base, 'missing-root')], root)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rootResolver unexpected filesystem errors', () => {
  const canTest = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canTest)('answers forbidden when an outside directory is unreadable', async () => {
    const locked = join(outside, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'x.pdf'), 'x');
    chmodSync(locked, 0o000);
    try {
      const resolve = rootResolver([root], root);
      const error = await resolve(join(locked, 'x.pdf')).catch((e) => e);
      expect(error).toMatchObject({ code: 'forbidden', message: 'Path is outside the allowed roots' });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('answers forbidden for a symlink loop outside the roots', async () => {
    symlinkSync(join(outside, 'loop-b'), join(outside, 'loop-a'));
    symlinkSync(join(outside, 'loop-a'), join(outside, 'loop-b'));
    const resolve = rootResolver([root], root);
    await expect(resolve(join(outside, 'loop-a'))).rejects.toMatchObject({ code: 'forbidden' });
  });
});
