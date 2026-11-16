import { realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './launch.mjs';

export const CONVERTIBLE_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp']);

export function isCandidate(payload) {
  if (typeof payload !== 'object' || payload === null || payload.tool_name !== 'Read') return false;
  const input = payload.tool_input;
  if (typeof input !== 'object' || input === null || input.pages !== undefined) return false;
  if (typeof input.file_path !== 'string') return false;
  return CONVERTIBLE_EXTENSIONS.has(extname(input.file_path).slice(1).toLowerCase());
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }
  if (!isCandidate(payload)) return;
  await launch(['hook', 'claude', '--plugin'], {
    stdio: ['pipe', 'inherit', 'ignore'],
    onSpawn: (child) => {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    },
  });
}

let direct = false;
try {
  direct = realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
} catch {}
if (direct) {
  try {
    await main();
  } catch {}
  process.exit(0);
}
