import { describe, expect, it } from 'vitest';
import { DistillError } from '../../../src/node/errors';
import { readEpub } from '../../../src/node/web/epub';
import { aesEncryption, fontObfuscation, makeEpub } from '../../fixtures/epub';

const NOW = () => new Date('2026-01-02T03:04:05Z');

const chapters = [
  { id: 'c1', file: 'ch1.xhtml', title: 'The Beginning', body: '<h1>The Beginning</h1><p>It was a <em>quiet</em> morning in the valley.</p><h2>Early light</h2><p>The sun rose over <a href="map.xhtml">the map</a>.</p>' },
  { id: 'c2', file: 'sub/ch2.xhtml', title: 'The Middle', body: '<p>No heading here, only a paragraph that continues the story for a while.</p><pre><code class="language-py">print("hi")</code></pre>' },
  { id: 'c3', file: 'ch3.xhtml', body: '<h2>Epilogue</h2><p>It ended well.</p><table><tr><th>Year</th><th>Event</th></tr><tr><td>1999</td><td>Found</td></tr></table>' },
];

async function fails(bytes: Uint8Array): Promise<DistillError> {
  const error = await readEpub(bytes, { now: NOW, label: 'book.epub' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DistillError);
  return error as DistillError;
}

describe('readEpub', () => {
  it('reads the spine in order with titles from nav.xhtml', async () => {
    const result = await readEpub(makeEpub({ chapters }), { now: NOW, label: 'book.epub' });
    const md = result.markdown;
    expect(md.split('\n')[0]).toBe('<!-- distill: book.epub converted 2026-01-02T03:04:05.000Z; untrusted epub content -->');
    expect(md).toContain('# Sample Book');
    expect(md).toContain('Author: Ada Author');
    const first = md.indexOf('## The Beginning');
    const second = md.indexOf('## The Middle');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(md.indexOf('It was a *quiet* morning')).toBeGreaterThan(first);
    expect(md.indexOf('No heading here')).toBeGreaterThan(second);
    expect(result.pages).toBe(3);
  });

  it('does not repeat a chapter heading that matches the title', async () => {
    const { markdown } = await readEpub(makeEpub({ chapters }), { now: NOW, label: 'b.epub' });
    expect(markdown.match(/The Beginning/g)).toHaveLength(1);
  });

  it('nests chapter headings under the chapter title', async () => {
    const { markdown } = await readEpub(makeEpub({ chapters }), { now: NOW, label: 'b.epub' });
    expect(markdown).toContain('### Early light');
    expect(markdown).not.toContain('\n# The Beginning');
  });

  it('falls back to the first heading, then the file name, when the TOC has no title', async () => {
    const { markdown } = await readEpub(makeEpub({ chapters, toc: 'none' }), { now: NOW, label: 'b.epub' });
    expect(markdown).toContain('## The Beginning');
    expect(markdown).toContain('## Epilogue');
    expect(markdown).toContain('## ch2');
  });

  it('reads titles from toc.ncx', async () => {
    const { markdown } = await readEpub(makeEpub({ chapters, toc: 'ncx' }), { now: NOW, label: 'b.epub' });
    expect(markdown).toContain('## The Middle');
    expect(markdown).toContain('## The Beginning');
  });

  it('resolves chapters in subfolders and keeps code and tables', async () => {
    const { markdown } = await readEpub(makeEpub({ chapters }), { now: NOW, label: 'b.epub' });
    expect(markdown).toContain('```py\nprint("hi")\n```');
    expect(markdown).toContain('| Year | Event |');
    expect(markdown).toContain('| 1999 | Found |');
  });

  it('accepts font obfuscation', async () => {
    const result = await readEpub(makeEpub({ chapters, encryption: fontObfuscation }), { now: NOW, label: 'b.epub' });
    expect(result.markdown).toContain('## The Beginning');
  });

  it('refuses DRM-protected content', async () => {
    const error = await fails(makeEpub({ chapters, encryption: aesEncryption }));
    expect(error.code).toBe('parse_failed');
    expect(error.message).toBe('This EPUB is DRM-protected');
  });

  it('refuses Adobe rights files', async () => {
    const error = await fails(makeEpub({ chapters, rights: true }));
    expect(error.message).toBe('This EPUB is DRM-protected');
  });

  it('rejects a file that is not a zip', async () => {
    const error = await fails(new Uint8Array(Buffer.from('plain text, not an epub')));
    expect(error.code).toBe('parse_failed');
  });

  it('rejects a zip without a container', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const error = await fails(zipSync({ 'hello.txt': strToU8('hi') }));
    expect(error.code).toBe('parse_failed');
    expect(error.message).toContain('EPUB');
  });

  it('rejects a book with no readable chapters', async () => {
    const error = await fails(makeEpub({ chapters: [] }));
    expect(error.code).toBe('parse_failed');
    expect(error.message).toContain('no readable chapters');
  });

  it('skips a spine entry whose file is missing', async () => {
    const bytes = makeEpub({ chapters: [...chapters, { id: 'gone', file: 'gone.xhtml', body: '' }] });
    const { unzipSync, zipSync } = await import('fflate');
    const files = unzipSync(bytes);
    delete files['OEBPS/gone.xhtml'];
    const result = await readEpub(zipSync(files), { now: NOW, label: 'b.epub' });
    expect(result.pages).toBe(3);
  });

  it('gives untrusted instructions no special treatment but does not run scripts', async () => {
    const { markdown } = await readEpub(
      makeEpub({ chapters: [{ id: 'c', file: 'c.xhtml', title: 'Scripted', body: '<p>Visible text for the reader.</p><script>window.alert(1)</script><p hidden>HIDDEN-EPUB-MARKER</p>' }] }),
      { now: NOW, label: 'b.epub' },
    );
    expect(markdown).toContain('Visible text for the reader.');
    expect(markdown).not.toContain('alert');
    expect(markdown).not.toContain('HIDDEN-EPUB-MARKER');
  });
});
