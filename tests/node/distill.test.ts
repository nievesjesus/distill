import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACTIVE, runBoosters } from '../../src/core/boosters/pipeline';
import { estimateSavings } from '../../src/core/savings';
import { countTokens } from '../../src/core/tokens';
import type { LinguaStatus } from '../../src/core/types';
import { createDistiller } from '../../src/node/distill';
import { DistillError } from '../../src/node/errors';
import type { Lingua } from '../../src/node/lingua';
import { createParser } from '../../src/node/parse';
import type { Parser } from '../../src/node/parse';
import { withBuiltinOffice } from '../../src/node/office';
import { makeDocx } from '../fixtures/office';
import { makeSamplePdf } from '../fixtures/make-pdf';

const RAW = 'Title\n\n\n\nBody   text\n\n\n\nMore';

let dir: string;
let pdfPath: string;
let docPath: string;
let txtPath: string;
let bigPath: string;

function fakeParser(markdown = RAW): Parser {
  return {
    toMarkdown: vi.fn(async () => ({ markdown, pages: 3 })),
    toJson: vi.fn(),
    renderPage: vi.fn(async () => ({ png: Buffer.from('PNG'), width: 850, height: 1100 })),
    close: vi.fn(),
  };
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
  docPath = join(dir, 'a.doc');
  txtPath = join(dir, 'a.txt');
  bigPath = join(dir, 'big.pdf');
  await writeFile(pdfPath, makeSamplePdf(['Quarterly Report', 'Revenue grew']));
  await writeFile(docPath, 'x');
  await writeFile(txtPath, 'x');
  await writeFile(bigPath, Buffer.alloc(100));
  await mkdir(join(dir, 'folder.pdf'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('health', () => {
  it('reports the asr status when provided and omits it otherwise', () => {
    const asr = { installed: true, runtime: true, models: true, ffmpeg: null, installable: true, diskBytes: 1 };
    expect(createDistiller({ parser: fakeParser(), libreoffice: true, asrStatus: () => asr }).health().asr).toEqual(asr);
    expect(createDistiller({ parser: fakeParser(), libreoffice: true }).health().asr).toBeUndefined();
  });
});

describe('renderPage', () => {
  it('renders a pdf page through the parser at 100 dpi', async () => {
    const parser = fakeParser();
    const distiller = createDistiller({ parser, libreoffice: true });
    const page = await distiller.renderPage(pdfPath, 2);
    expect(parser.renderPage).toHaveBeenCalledWith(pdfPath, 2, { dpi: 100 });
    expect(page).toEqual({ image: Buffer.from('PNG'), mimeType: 'image/png', width: 850, height: 1100 });
  });

  it('returns an image file itself', async () => {
    const png = join(dir, 'pic.png');
    await writeFile(png, Buffer.from('rawpng'));
    const parser = fakeParser();
    const page = await createDistiller({ parser, libreoffice: true }).renderPage(png, 1);
    expect(page).toEqual({ image: Buffer.from('rawpng'), mimeType: 'image/png' });
    expect(parser.renderPage).not.toHaveBeenCalled();
  });

  it('rejects page 2 of an image', async () => {
    const png = join(dir, 'pic2.png');
    await writeFile(png, Buffer.from('rawpng'));
    await expectCode(createDistiller({ parser: fakeParser(), libreoffice: true }).renderPage(png, 2), 'bad_request');
  });

  it('rejects other kinds with bad_request', async () => {
    const docx = join(dir, 'a.docx');
    await writeFile(docx, 'x');
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    await expectCode(distiller.renderPage(docx, 1), 'bad_request');
    await expectCode(distiller.renderPage(txtPath, 1), 'unsupported_type');
  });

  it('rejects a bad page number and missing files', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true });
    await expectCode(distiller.renderPage(pdfPath, 0), 'bad_request');
    await expectCode(distiller.renderPage(join(dir, 'missing.pdf'), 1), 'not_found');
  });

  it('enforces the size limit', async () => {
    await expectCode(createDistiller({ parser: fakeParser(), libreoffice: true, maxBytes: 10 }).renderPage(bigPath, 1), 'too_large');
  });
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
    await expectCode(distiller.distillFile(docPath), 'needs_libreoffice');
  });

  it('converts a docx through the built-in reader without LibreOffice', async () => {
    const docxPath = join(dir, 'real.docx');
    await writeFile(docxPath, makeDocx('<w:p><w:r><w:t>Hello builtin</w:t></w:r></w:p>'));
    const distiller = createDistiller({ parser: withBuiltinOffice(fakeParser(), { libreoffice: false }), libreoffice: false });
    const result = await distiller.distillFile(docxPath);
    expect(result.markdown).toContain('Hello builtin');
    expect(result.engine).toBe('builtin');
  });

  it('fails with too_large above maxBytes', async () => {
    const distiller = createDistiller({ parser: fakeParser(), libreoffice: true, maxBytes: 10 });
    await expectCode(distiller.distillFile(bigPath), 'too_large');
  });

  it('fails with lingua_unavailable when lingua is requested and not installed', async () => {
    const distiller = createDistiller({ parser: fakeParser(), lingua: fakeLingua(false), libreoffice: true });
    const promise = distiller.distillFile(pdfPath, { lingua: true });
    await expectCode(promise, 'lingua_unavailable');
    await expect(promise).rejects.toThrow('LLMLingua-2 is not installed. Install it once from the web app (npx distill-llm).');
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

describe('createDistiller with audio and video', () => {
  it('passes the transcript options to the parser and reports SRT tokens as raw', async () => {
    const audio = join(dir, 'talk.m4a');
    await writeFile(audio, 'x');
    const toMarkdown = vi.fn(async () => ({ markdown: '[00:00] hello world', pages: 1, rawTokens: 40 }));
    const parser = { ...fakeParser(), toMarkdown } as Parser;
    const controller = new AbortController();
    const result = await createDistiller({ parser, libreoffice: true }).distillFile(audio, { timestamps: 'none', frames: 'none', signal: controller.signal });
    expect(toMarkdown).toHaveBeenCalledWith(audio, { timestamps: 'none', frames: 'none', signal: controller.signal });
    expect(result.kind).toBe('AUDIO');
    expect(result.tokens.raw).toBe(40);
    expect(estimateSavings(result).basis).toBe('srt');
  });

  it('allows audio and video up to 2 GB under the default limit but not beyond', async () => {
    const parser = { ...fakeParser(), toMarkdown: vi.fn(async () => ({ markdown: 'x', pages: 1 })) } as Parser;
    const distiller = createDistiller({ parser, libreoffice: true });
    const big = join(dir, 'big-talk.mp4');
    await writeFile(big, '');
    await truncate(big, 150 * 1024 * 1024);
    await expect(distiller.distillFile(big)).resolves.toMatchObject({ kind: 'VIDEO' });
    await truncate(big, 2 * 1024 * 1024 * 1024 + 1);
    await expectCode(distiller.distillFile(big), 'too_large');
    const doc = join(dir, 'big-doc.pdf');
    await writeFile(doc, '');
    await truncate(doc, 150 * 1024 * 1024);
    await expectCode(distiller.distillFile(doc), 'too_large');
  });

  it('surfaces asr_unavailable from the parser', async () => {
    const video = join(dir, 'clip.mp4');
    await writeFile(video, 'x');
    const parser = {
      ...fakeParser(),
      toMarkdown: vi.fn(async () => {
        throw new DistillError('asr_unavailable', 'Speech recognition is not installed.');
      }),
    } as Parser;
    await expectCode(createDistiller({ parser, libreoffice: true }).distillFile(video), 'asr_unavailable');
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
