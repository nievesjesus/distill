import { strToU8, zipSync } from 'fflate';

const MARKDOWN_TYPE = 'text/markdown;charset=utf-8';

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function zipName(date: Date = new Date()): string {
  return `distill-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}

export function downloadText(name: string, text: string): void {
  saveBlob(name, new Blob([text], { type: MARKDOWN_TYPE }));
}

export async function downloadZip(entries: { name: string; text: string }[]): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.name] = strToU8(entry.text);
  const zipped = zipSync(files);
  saveBlob(zipName(), new Blob([zipped as BlobPart], { type: 'application/zip' }));
}
