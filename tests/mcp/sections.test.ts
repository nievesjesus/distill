import { describe, expect, it } from 'vitest';
import { closestHeadings, findSection, normalizeTitle } from '../../src/mcp/sections';

const doc = [
  '# File system',
  '',
  '## Promise API',
  '',
  '### `fsPromises.cp(src, dest[, options])`',
  '',
  'Added in: v16.7.0',
  '',
  '### `fsPromises.writeFile(file, data[, options])`',
  '',
  'promise write',
  '',
  '## Callback API',
  '',
  '### `fs.cp(src, dest[, options], callback)`',
  '',
  'Added in: v16.7.0 cb',
  '',
  '### `fs.writeFile(file, data[, options], callback)`',
  '',
  'callback write',
  '',
  '```js',
  '### not a heading',
  '```',
  '',
  '### **Bold** and [linked](https://x.example/a_(b)) title',
  '',
  'tail',
  '',
].join('\n');

const lines = doc.split('\n');
const at = (needle: string): number => lines.findIndex((line) => line.includes(needle)) + 1;

describe('findSection', () => {
  it('matches a heading written with backticks, parentheses and brackets', () => {
    const found = findSection(doc, 'fs.writeFile(file, data[, options], callback)');
    expect(found?.line).toBe(at('### `fs.writeFile'));
    expect(lines[(found?.endLine ?? 0) - 1]).toBe('');
  });

  it('matches a prefix such as the start of a signature', () => {
    expect(findSection(doc, 'fs.writeFile(')?.line).toBe(at('### `fs.writeFile'));
    expect(findSection(doc, 'fs.writeFile')?.line).toBe(at('### `fs.writeFile'));
  });

  it('prefers the callback fs.cp over the promise fsPromises.cp', () => {
    expect(findSection(doc, 'fs.cp')?.line).toBe(at('### `fs.cp'));
  });

  it('matches without punctuation', () => {
    expect(findSection(doc, 'fs cp src dest options callback')?.line).toBe(at('### `fs.cp'));
    expect(findSection(doc, 'fspromises cp')?.line).toBe(at('### `fsPromises.cp'));
  });

  it('is case-insensitive and ignores hashes and backticks in the query', () => {
    expect(findSection(doc, '### `FS.WRITEFILE`')?.line).toBe(at('### `fs.writeFile'));
  });

  it('falls back to a substring', () => {
    expect(findSection(doc, 'writeFile(file, data[, options])')?.line).toBe(at('### `fsPromises.writeFile'));
    expect(findSection(doc, 'linked')?.line).toBe(at('linked'));
  });

  it('strips emphasis and link syntax from headings', () => {
    expect(findSection(doc, 'Bold and linked title')?.line).toBe(at('**Bold**'));
  });

  it('ends a section at the next heading of the same or a higher level', () => {
    const promise = findSection(doc, 'Promise API');
    expect(promise?.endLine).toBe(at('## Callback API') - 1);
    const cb = findSection(doc, 'Callback API');
    expect(cb?.endLine).toBe(lines.length);
  });

  it('ignores headings inside code fences', () => {
    expect(findSection(doc, 'not a heading')).toBeNull();
  });

  it('finds headings on a page with more than 150 of them', () => {
    const big = ['# Big', ...Array.from({ length: 400 }, (_, i) => `#### \`api.method${i}(a, b)\`\n\nbody ${i}\n`)].join('\n');
    const found = findSection(big, 'api.method321(');
    expect(big.split('\n')[(found?.line ?? 0) - 1]).toBe('#### `api.method321(a, b)`');
    expect(found?.endLine).toBe((found?.line ?? 0) + 3);
  });

  it('returns null for an empty query or no match', () => {
    expect(findSection(doc, '')).toBeNull();
    expect(findSection(doc, '###')).toBeNull();
    expect(findSection(doc, 'nonexistent thing')).toBeNull();
  });

  it('falls back to the outline for documents without headings', () => {
    const pages = '<!-- page 1 -->\n\nAlpha text here\n\n<!-- page 2 -->\n\nBeta text here\n';
    expect(findSection(pages, 'Beta text')?.line).toBe(5);
  });
});

describe('closestHeadings', () => {
  it('lists up to five headings that share words with the query', () => {
    const near = closestHeadings(doc, 'fs.writeFile promise');
    expect(near.length).toBeLessThanOrEqual(5);
    expect(near.some((title) => title.includes('fsPromises.writeFile'))).toBe(true);
    expect(near[0]).toContain('writeFile');
    expect(near.some((title) => title.includes('fs.writeFile'))).toBe(true);
  });

  it('falls back to the first headings when nothing is similar', () => {
    const near = closestHeadings(doc, 'zzz');
    expect(near[0]).toBe('File system');
    expect(near).toHaveLength(5);
  });

  it('returns clean titles without markup', () => {
    for (const title of closestHeadings(doc, 'bold')) expect(title).not.toMatch(/[`*#]/);
  });
});

describe('angle brackets in headings', () => {
  const hostile = '### <<script>script>alert(1)<</script>/script> Title\n\nbody\n';

  it('leaves none in the suggested titles', () => {
    for (const title of closestHeadings(hostile, 'alert')) expect(title).not.toMatch(/[<>]/);
  });

  it('matches a heading by its text once the markup is gone', () => {
    expect(findSection(hostile, 'title')?.line).toBe(1);
    expect(normalizeTitle('<<script>script>alert(1)<</script>/script>')).not.toMatch(/[<>]/);
  });

  it('strips nested tags until stable and leaves no angle brackets', () => {
    expect(normalizeTitle('<<b>b>x<</b>/b>')).toBe('x');
    for (const raw of ['<<b>b>x<</b>/b>', '<a <b>c', 'x <unclosed', 'a > b <', '<<<>>>y']) {
      expect(normalizeTitle(raw)).not.toMatch(/[<>]/);
      expect(closestHeadings(`### ${raw}\n\nbody\n`, 'x').join('')).not.toMatch(/[<>]/);
    }
  });
});
