import mammoth from 'mammoth';
import { DistillError } from '../errors';
import { htmlToMarkdown } from './html-to-markdown';
import type { OfficeResult } from './markdown';
import { readZip } from './zip';

export async function readDocx(bytes: Uint8Array): Promise<OfficeResult> {
  readZip(bytes);
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const attrs: { src: string; alt?: string } = { src: '', alt: (image as { altText?: string }).altText ?? '' };
          return attrs;
        }),
      },
    );
    return { markdown: htmlToMarkdown(result.value), pages: 1, json: { html: result.value } };
  } catch (error) {
    throw new DistillError('parse_failed', 'Could not read the Word document', { cause: error });
  }
}
