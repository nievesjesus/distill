import { zipSync } from 'fflate';

const enc = (s: string) => new TextEncoder().encode(s);

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

function pack(parts: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(parts)) files[name] = enc(body);
  return zipSync(files);
}

function contentTypes(overrides: [string, string][]): string {
  const items = overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('');
  return `${XML}<Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${items}</Types>`;
}

function rels(items: { id: string; type: string; target: string }[]): string {
  const body = items.map((i) => `<Relationship Id="${i.id}" Type="${i.type}" Target="${i.target}"/>`).join('');
  return `${XML}<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

function rootRels(target: string): string {
  return rels([{ id: 'rId1', type: `${OD_REL}/officeDocument`, target }]);
}

export function makeDocx(
  bodyXml: string,
  extras: { styles?: string; numbering?: string; rels?: string } = {},
): Uint8Array {
  const wns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const overrides: [string, string][] = [
    ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  ];
  const relItems: { id: string; type: string; target: string }[] = [];
  const parts: Record<string, string> = {};
  if (extras.styles) {
    overrides.push(['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml']);
    relItems.push({ id: 'rIdStyles', type: `${OD_REL}/styles`, target: 'styles.xml' });
    parts['word/styles.xml'] = extras.styles;
  }
  if (extras.numbering) {
    overrides.push(['/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml']);
    relItems.push({ id: 'rIdNumbering', type: `${OD_REL}/numbering`, target: 'numbering.xml' });
    parts['word/numbering.xml'] = extras.numbering;
  }
  const relsXml = extras.rels ?? rels(relItems);
  return pack({
    '[Content_Types].xml': contentTypes(overrides),
    '_rels/.rels': rootRels('word/document.xml'),
    'word/document.xml': `${XML}<w:document xmlns:w="${wns}" xmlns:r="${OD_REL}"><w:body>${bodyXml}</w:body></w:document>`,
    'word/_rels/document.xml.rels': relsXml,
    ...parts,
  });
}

function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function makeXlsx(
  sheets: { name: string; rows: (string | number | boolean | null)[][]; hidden?: boolean; rawRows?: string }[],
  opts: { sharedStrings?: boolean } = {},
): Uint8Array {
  const useShared = opts.sharedStrings !== false;
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sst = (value: string): number => {
    const known = sharedIndex.get(value);
    if (known !== undefined) return known;
    shared.push(value);
    sharedIndex.set(value, shared.length - 1);
    return shared.length - 1;
  };

  const parts: Record<string, string> = {};
  const overrides: [string, string][] = [
    ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  ];
  const wbRels: { id: string; type: string; target: string }[] = [];
  const sheetEntries: string[] = [];

  sheets.forEach((sheet, i) => {
    const n = i + 1;
    const rowsXml =
      sheet.rawRows ??
      sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            if (value === null) return '';
            const ref = `${columnName(c)}${r + 1}`;
            if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
            if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
            if (useShared) return `<c r="${ref}" t="s"><v>${sst(value)}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    parts[`xl/worksheets/sheet${n}.xml`] =
      `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
    overrides.push([`/xl/worksheets/sheet${n}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']);
    wbRels.push({ id: `rId${n}`, type: `${OD_REL}/worksheet`, target: `worksheets/sheet${n}.xml` });
    sheetEntries.push(`<sheet name="${esc(sheet.name)}" sheetId="${n}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${n}"/>`);
  });

  if (useShared && shared.length > 0) {
    const items = shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('');
    parts['xl/sharedStrings.xml'] =
      `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${items}</sst>`;
    overrides.push(['/xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml']);
    wbRels.push({ id: 'rIdShared', type: `${OD_REL}/sharedStrings`, target: 'sharedStrings.xml' });
  }

  return pack({
    '[Content_Types].xml': contentTypes(overrides),
    '_rels/.rels': rootRels('xl/workbook.xml'),
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OD_REL}"><sheets>${sheetEntries.join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels(wbRels),
    ...parts,
  });
}

export function makePptx(
  slides: { title?: string; paragraphs: string[]; notes?: string; rawBody?: string }[],
  options: { order?: number[] } = {},
): Uint8Array {
  const pns = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const ans = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const parts: Record<string, string> = {};
  const overrides: [string, string][] = [
    ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
  ];
  const presRels: { id: string; type: string; target: string }[] = [];
  const idList: string[] = [];

  slides.forEach((slide, i) => {
    const n = i + 1;
    const titleShape =
      slide.title === undefined
        ? ''
        : `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(slide.title)}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const paras = slide.paragraphs.map((p) => `<a:p><a:r><a:t>${esc(p)}</a:t></a:r></a:p>`).join('');
    const bodyShape =
      slide.rawBody ??
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content ${n}"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
    parts[`ppt/slides/slide${n}.xml`] =
      `${XML}<p:sld xmlns:a="${ans}" xmlns:r="${OD_REL}" xmlns:p="${pns}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${titleShape}${bodyShape}</p:spTree></p:cSld></p:sld>`;
    overrides.push([`/ppt/slides/slide${n}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']);
    presRels.push({ id: `rId${n}`, type: `${OD_REL}/slide`, target: `slides/slide${n}.xml` });
    idList.push(`<p:sldId id="${255 + n}" r:id="rId${n}"/>`);

    if (slide.notes !== undefined) {
      parts[`ppt/notesSlides/notesSlide${n}.xml`] =
        `${XML}<p:notes xmlns:a="${ans}" xmlns:r="${OD_REL}" xmlns:p="${pns}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes ${n}"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(slide.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
      overrides.push([`/ppt/notesSlides/notesSlide${n}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml']);
      parts[`ppt/slides/_rels/slide${n}.xml.rels`] = rels([
        { id: 'rId1', type: `${OD_REL}/notesSlide`, target: `../notesSlides/notesSlide${n}.xml` },
      ]);
    }
  });

  return pack({
    '[Content_Types].xml': contentTypes(overrides),
    '_rels/.rels': rootRels('ppt/presentation.xml'),
    'ppt/presentation.xml': `${XML}<p:presentation xmlns:a="${ans}" xmlns:r="${OD_REL}" xmlns:p="${pns}"><p:sldIdLst>${(options.order ?? idList.map((_, i) => i)).map((i) => idList[i]).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(presRels),
    ...parts,
  });
}
