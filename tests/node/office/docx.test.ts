import { describe, expect, it } from 'vitest';
import { DistillError } from '../../../src/node/errors';
import { readDocx } from '../../../src/node/office/docx';
import { makeDocx } from '../../fixtures/office';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rIdStyles" Type="${OD}/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="${OD}/numbering" Target="numbering.xml"/><Relationship Id="rIdLink" Type="${OD}/hyperlink" Target="https://example.test/page" TargetMode="External"/></Relationships>`;

const run = (text: string, props = ''): string => `<w:r>${props === '' ? '' : `<w:rPr>${props}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, pPr = ''): string => `<w:p>${pPr === '' ? '' : `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const cell = (text: string): string => `<w:tc>${para(run(text))}</w:tc>`;

const body = [
  para(run('Quarterly Report'), '<w:pStyle w:val="Heading1"/>'),
  para(run('Plain ') + run('boldword', '<w:b/>') + run(' ') + run('italicword', '<w:i/>')),
  para(`<w:hyperlink r:id="rIdLink">${run('linktext')}</w:hyperlink>`),
  para(run('stepone'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  para(run('steptwo'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  `<w:tbl><w:tr>${cell('Name')}${cell('Score')}</w:tr><w:tr>${cell('Ada')}${cell('42')}</w:tr></w:tbl>`,
].join('');

describe('readDocx', () => {
  it('converts a document to markdown', async () => {
    const r = await readDocx(makeDocx(body, { styles, numbering, rels }));
    expect(r.pages).toBe(1);
    expect(r.markdown).toContain('# Quarterly Report');
    expect(r.markdown).toContain('**boldword**');
    expect(r.markdown).toContain('*italicword*');
    expect(r.markdown).toContain('[linktext](https://example.test/page)');
    expect(r.markdown).toContain('1. stepone');
    expect(r.markdown).toContain('1. steptwo');
    expect(r.markdown).toContain('| Name | Score |');
    expect(r.markdown).toContain('| Ada | 42 |');
    for (const word of ['Quarterly', 'Report', 'Plain', 'boldword', 'italicword', 'linktext', 'stepone', 'steptwo', 'Name', 'Score', 'Ada', '42']) {
      expect(r.markdown).toContain(word);
    }
    expect(typeof (r.json as { html: string }).html).toBe('string');
  });

  it('maps corrupt documents to parse_failed', async () => {
    const bad = makeDocx(body, { styles, numbering, rels });
    const broken = new Uint8Array(bad.length);
    broken.set(bad);
    await expect(readDocx(broken.subarray(0, 10))).rejects.toBeInstanceOf(DistillError);
  });
});
