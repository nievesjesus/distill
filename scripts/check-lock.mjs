import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const required = ['node_modules/@huggingface/transformers', 'node_modules/js-tiktoken'];
const problems = [];

for (const key of required) {
  if (!lock.packages[key]) problems.push(`missing ${key}`);
}
for (const [key, entry] of Object.entries(lock.packages)) {
  if (key === '' || entry.link) continue;
  if (!entry.integrity) problems.push(`no integrity: ${key}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lockfile ok');
