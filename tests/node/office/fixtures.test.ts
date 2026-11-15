import { describe, expect, it } from 'vitest';
import { readZip, zipText } from '../../../src/node/office/zip';
import { parseXml } from '../../../src/node/office/xml';
import { makeDocx, makePptx, makeXlsx } from '../../fixtures/office';

describe('office fixtures', () => {
  it('build well-formed archives', () => {
    const archives = [
      makeDocx('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>', { styles: '<w:styles xmlns:w="urn:w"/>' }),
      makeXlsx([{ name: 'S&1', rows: [['x', 1, true, null]] }]),
      makeXlsx([{ name: 'S', rows: [['x']] }], { sharedStrings: false }),
      makePptx([{ title: 'T', paragraphs: ['p<1>'], notes: 'n' }, { paragraphs: ['q'] }]),
    ];
    for (const bytes of archives) {
      const entries = readZip(bytes);
      expect(zipText(entries, '[Content_Types].xml')).not.toBeNull();
      for (const name of entries.keys()) {
        if (name.endsWith('.xml') || name.endsWith('.rels')) expect(() => parseXml(zipText(entries, name)!)).not.toThrow();
      }
    }
  });
});
