import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata';
const SHA256 = '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba';
const FETCH_TIMEOUT_MS = 120_000;
const targetUrl = new URL('../.cache/tessdata/eng.traineddata', import.meta.url);
const target = fileURLToPath(targetUrl);
const targetDir = fileURLToPath(new URL('.', targetUrl));
const temp = `${target}.${process.pid}.tmp`;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

if (existsSync(target) && sha256(readFileSync(target)) === SHA256) {
  console.log('tessdata cached');
  process.exit(0);
}

let data;
try {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    console.error(`tessdata download failed: HTTP ${response.status}`);
    process.exit(1);
  }
  data = Buffer.from(await response.arrayBuffer());
} catch (error) {
  console.error(`tessdata download failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
try {
  writeFileSync(temp, data);
  const actual = sha256(readFileSync(temp));
  if (actual !== SHA256) {
    console.error(`tessdata checksum mismatch: expected ${SHA256}, got ${actual}`);
    process.exit(1);
  }
  renameSync(temp, target);
} finally {
  rmSync(temp, { force: true });
}
console.log('tessdata downloaded');
