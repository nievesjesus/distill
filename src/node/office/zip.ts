import { unzipSync } from 'fflate';
import { DistillError } from '../errors';

const MAX_ENTRIES = 5000;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ENTRY = 64 * 1024 * 1024;

class LimitError extends Error {}

export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  let count = 0;
  let total = 0;
  try {
    const files = unzipSync(bytes, {
      filter(file) {
        count += 1;
        total += file.originalSize;
        if (count > MAX_ENTRIES || file.originalSize > MAX_ENTRY || total > MAX_TOTAL) throw new LimitError();
        return true;
      },
    });
    return new Map(Object.entries(files));
  } catch (error) {
    if (error instanceof LimitError) {
      throw new DistillError('parse_failed', 'Document archive is too large to read safely', { cause: error });
    }
    throw new DistillError('parse_failed', 'Could not read the document archive', { cause: error });
  }
}

export function zipText(entries: Map<string, Uint8Array>, name: string): string | null {
  const data = entries.get(name);
  return data ? new TextDecoder('utf-8').decode(data) : null;
}
