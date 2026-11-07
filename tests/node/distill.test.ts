import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACTIVE, runBoosters } from '../../src/core/boosters/pipeline';
import { countTokens } from '../../src/core/tokens';
import type { LinguaStatus } from '../../src/core/types';
import { createDistiller } from '../../src/node/distill';
import { DistillError } from '../../src/node/errors';
import type { Lingua } from '../../src/node/lingua';
import { createParser } from '../../src/node/parse';
import type { Parser } from '../../src/node/parse';
import { makeSamplePdf } from '../fixtures/make-pdf';

const RAW = 'Title\n\n\n\nBody   text\n\n\n\nMore';

let dir: string;
let pdfPath: string;
let docxPath: string;
let txtPath: string;
let bigPath: string;

function fakeParser(markdown = RAW): Parser {
  return { toMarkdown: vi.fn(async () => ({ markdown, pages: 3 })), toJson: vi.fn(), close: vi.fn() };
}

function fakeLingua(installed: boolean): Lingua {
  const status = { installed } as LinguaStatus;
  return {
    status: () => status,
    compress: vi.fn(async (text: string) => text.toUpperCase()),
    probe: vi.fn(),
    install: vi.fn(),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DistillError);
  expect((error as DistillError).code).toBe(code);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'distill-core-'));
  pdfPath = join(dir, 'a.pdf');
  docxPath = join(dir, 'a.docx');
  txtPath = join(dir, 'a.txt');
  bigPath = join(dir, 'big.pdf');
  await writeFile(pdfPath, makeSamplePdf(['Quarterly Report', 'Revenue grew']));
  await writeFile(docxPath, 'x');
  await writeFile(txtPath, 'x');
  await writeFile(bigPath, Buffer.alloc(100));
  await mkdir(join(dir, 'folder.pdf'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createDistiller with a fake parser', () => {
  it('counts raw tokens and the tokens of the boosted output', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    const result = await distiller.distillFile(pdfPath);
    expect(result.tokens.raw).toBe(countTokens(RAW));
    expect(result.tokens.out).toBe(countTokens(runBoosters(RAW, DEFAULT_ACTIVE)));
    expect(result.markdown).toBe(runBoosters(RAW, DEFAULT_ACTIVE));
    expect(result).toMatchObject({ path: pdfPath, name: 'a.pdf', kind: 'PDF', pages: 3 });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('leaves the markdown untouched without boosters', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    const result = await distiller.distillFile(pdfPath, { boosters: new Set() });
    expect(result.markdown).toBe(RAW);
    expect(result.tokens.out).toBe(result.tokens.raw);
  });

  it('fails with not_found for a missing path', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    await expectCode(distiller.distillFile(join(dir, 'missing.pdf')), 'not_found');
  });

  it('fails with not_found for a directory', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    await expectCode(distiller.distillFile(join(dir, 'folder.pdf')), 'not_found');
  });

  it('fails with unsupported_type for a text file', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    await expectCode(distiller.distillFile(txtPath), 'unsupported_type');
  });

  it('fails with needs_libreoffice for office files without LibreOffice', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: false });
    await expectCode(distiller.distillFile(docxPath), 'needs_libreoffice');
  });

  it('fails with too_large above maxBytes', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true, maxBytes: 10 });
    await expectCode(distiller.distillFile(bigPath), 'too_large');
  });

  it('fails with lingua_unavailable when lingua is requested and not installed', async () => {
    const distiller = createDistiller({ parser: fakeParser(), lingua: fakeLingua(false), libreoffice: true });
    const promise = distiller.distillFile(pdfPath, { lingua: true });
    await expectCode(promise, 'lingua_unavailable');
    await expect(promise).rejects.toThrow('LLMLingua-2 is not installed. Install it once from the web app (npx distillmd).');
  });

  it('explains why lingua cannot be installed when the status carries a reason', async () => {
    const lingua = { ...fakeLingua(false), status: () => ({ installed: false, installable: false, model: 'tinybert' as const, state: 'idle' as const, progress: 0, unsupportedReason: 'Intel Macs are out' }) };
    const distiller = createDistiller({ parser: fakeParser(), lingua, libreoffice: true });
    await expect(distiller.distillFile(pdfPath, { lingua: true })).rejects.toThrow('Intel Macs are out');
  });

  it('fails with lingua_unavailable when lingua is requested without a runtime', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    await expectCode(distiller.distillFile(pdfPath, { lingua: true }), 'lingua_unavailable');
  });

  it('compresses the booster output with the given rate and counts the final text', async () => {
    const lingua = fakeLingua(true);
    const distiller = createDistiller({ parser: fakeParser(), lingua, libreoffice: true });
    const result = await distiller.distillFile(pdfPath, { lingua: true, rate: 0.3 });
    const boosted = runBoosters(RAW, DEFAULT_ACTIVE);
    expect(lingua.compress).toHaveBeenCalledWith(boosted, { rate: 0.3 });
    expect(result.markdown).toBe(boosted.toUpperCase());
    expect(result.tokens.out).toBe(countTokens(boosted.toUpperCase()));
  });

  it('uses a rate of 0.5 by default', async () => {
    const lingua = fakeLingua(true);
    const distiller = createDistiller({ parser: fakeParser(), lingua, libreoffice: true });
    await distiller.distillFile(pdfPath, { lingua: true });
    expect(lingua.compress).toHaveBeenCalledWith(expect.any(String), { rate: 0.5 });
  });

  it('closes the parser', () => {
    const parser = fakeParser();
    createDistiller({ parser, libreoffice: true }).close();
    expect(parser.close).toHaveBeenCalled();
  });
});

describe('createDistiller with the real parser', () => {
  it('distills a generated pdf', async () => {
    const parser = createParser({ poolSize: 1 });
    try {
      const result = await createDistiller({ parser, libreoffice: false }).distillFile(pdfPath);
      expect(result.kind).toBe('PDF');
      expect(result.pages).toBe(1);
      expect(result.markdown).toContain('Quarterly Report');
      expect(result.tokens.raw).toBeGreaterThan(0);
    } finally {
      parser.close();
    }
  }, 30_000);
});
