import { strToU8, zipSync } from 'fflate';

export interface EpubChapter {
  id: string;
  file: string;
  title?: string;
  body: string;
}

export interface EpubOptions {
  title?: string;
  creator?: string;
  chapters: EpubChapter[];
  toc?: 'nav' | 'ncx' | 'none';
  encryption?: string;
  rights?: boolean;
  extra?: Record<string, string>;
}

const xhtml = (title: string, body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`;

export function makeEpub(options: EpubOptions): Uint8Array {
  const toc = options.toc ?? 'nav';
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  };
  const manifest = options.chapters.map((c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`);
  if (toc === 'nav') manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  if (toc === 'ncx') manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  const spine = options.chapters.map((c) => `<itemref idref="${c.id}"/>`).join('');
  files['OEBPS/content.opf'] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:1</dc:identifier><dc:title>${options.title ?? 'Sample Book'}</dc:title><dc:creator>${options.creator ?? 'Ada Author'}</dc:creator><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine${toc === 'ncx' ? ' toc="ncx"' : ''}>${spine}</spine></package>`,
  );
  for (const chapter of options.chapters) files[`OEBPS/${chapter.file}`] = strToU8(xhtml(chapter.title ?? chapter.id, chapter.body));
  const titled = options.chapters.filter((c) => c.title);
  if (toc === 'nav') {
    const items = titled.map((c) => `<li><a href="${c.file}">${c.title}</a></li>`).join('');
    files['OEBPS/nav.xhtml'] = strToU8(xhtml('Contents', `<nav epub:type="toc"><ol>${items}</ol></nav>`));
  }
  if (toc === 'ncx') {
    const points = titled
      .map((c, i) => `<navPoint id="p${i}" playOrder="${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="${c.file}"/></navPoint>`)
      .join('');
    files['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`);
  }
  if (options.encryption) files['META-INF/encryption.xml'] = strToU8(options.encryption);
  if (options.rights) files['META-INF/rights.xml'] = strToU8('<rights xmlns="http://ns.adobe.com/adept"/>');
  for (const [name, text] of Object.entries(options.extra ?? {})) files[name] = strToU8(text);
  return zipSync(files);
}

export const fontObfuscation =
  '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/a.otf"/></enc:CipherData></enc:EncryptedData></encryption>';

export const aesEncryption =
  '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>';
