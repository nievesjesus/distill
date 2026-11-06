import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const URL_ENG = 'https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata';
const SHA256 = '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba';
const target = new URL('../.cache/tessdata/eng.traineddata', import.meta.url);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

if (existsSync(target) && sha256(readFileSync(target)) === SHA256) {
  console.log('tessdata cached');
  process.exit(0);
}

const response = await fetch(URL_ENG);
if (!response.ok) {
  console.error(`tessdata download failed: HTTP ${response.status}`);
  process.exit(1);
}
const data = Buffer.from(await response.arrayBuffer());
const actual = sha256(data);
if (actual !== SHA256) {
  console.error(`tessdata checksum mismatch: expected ${SHA256}, got ${actual}`);
  process.exit(1);
}
mkdirSync(dirname(target.pathname), { recursive: true });
writeFileSync(target, data);
console.log('tessdata downloaded');
