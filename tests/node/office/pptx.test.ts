import { describe, expect, it } from 'vitest';
import { readPptx } from '../../../src/node/office/pptx';
import { makePptx } from '../../fixtures/office';

const sp = (paras: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;

describe('readPptx', () => {
  it('renders titled slides with paragraphs', () => {
    const r = readPptx(
      makePptx([
        { title: 'Intro', paragraphs: ['Hello', 'World'] },
        { title: 'Next', paragraphs: ['More'] },
      ]),
    );
    expect(r.markdown).toBe('## Slide 1: Intro\n\nHello\nWorld\n\n## Slide 2: Next\n\nMore');
    expect(r.pages).toBe(2);
  });

  it('handles a slide without a title', () => {
    const r = readPptx(makePptx([{ paragraphs: ['Only body'] }]));
    expect(r.markdown).toBe('## Slide 1\n\nOnly body');
  });

  it('appends speaker notes', () => {
    const r = readPptx(makePptx([{ title: 'T', paragraphs: ['x'], notes: 'Say hi' }]));
    expect(r.markdown).toContain('> Notes: Say hi');
    expect(r.json).toEqual({ slides: [{ title: 'T', paragraphs: ['x'], notes: 'Say hi' }] });
  });

  it('renders bullets with indentation by level', () => {
    const body = sp(
      '<a:p><a:r><a:t>Plain</a:t></a:r></a:p>' +
        '<a:p><a:pPr><a:buChar char="-"/></a:pPr><a:r><a:t>Bullet</a:t></a:r></a:p>' +
        '<a:p><a:pPr lvl="1"/><a:r><a:t>Nested</a:t></a:r></a:p>' +
        '<a:p><a:pPr lvl="2"><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>Deep</a:t></a:r></a:p>',
    );
    const r = readPptx(makePptx([{ paragraphs: [], rawBody: body }]));
    expect(r.markdown).toBe('## Slide 1\n\nPlain\n- Bullet\n  - Nested\n    - Deep');
  });

  it('follows sldIdLst order, not file names', () => {
    const r = readPptx(
      makePptx([{ title: 'A', paragraphs: [] }, { title: 'B', paragraphs: [] }], { order: [1, 0] }),
    );
    expect(r.markdown).toBe('## Slide 1: B\n\n## Slide 2: A');
  });

  it('escapes a leading hash', () => {
    const r = readPptx(makePptx([{ paragraphs: ['# not a heading'] }]));
    expect(r.markdown).toContain('\\# not a heading');
  });

  it('renders tables through gfmTable', () => {
    const cell = (t: string): string => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></a:txBody></a:tc>`;
    const tbl = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>${cell('H1')}${cell('H2')}</a:tr><a:tr>${cell('a|b')}${cell('c')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const r = readPptx(makePptx([{ paragraphs: [], rawBody: tbl }]));
    expect(r.markdown).toBe('## Slide 1\n\n| H1 | H2 |\n| --- | --- |\n| a\\|b | c |');
  });
});
