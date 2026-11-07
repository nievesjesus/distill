import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(base, path), 'utf8'));
const problems = [];

function audit(label, lock, required) {
  for (const key of required) {
    if (!lock.packages[key]) problems.push(`${label}: missing ${key}`);
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.link) continue;
    if (!entry.integrity) problems.push(`${label}: no integrity: ${key}`);
  }
}

const linguaPackages = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'];
const root = read('package-lock.json');
const runtime = read('lingua-runtime/package-lock.json');
const runtimeManifest = read('lingua-runtime/package.json');

audit('root', root, []);
audit('lingua-runtime', runtime, linguaPackages.map((name) => `node_modules/${name}`));

for (const name of linguaPackages) {
  const pinned = runtimeManifest.dependencies?.[name];
  const locked = runtime.packages[`node_modules/${name}`]?.version;
  if (!/^\d+\.\d+\.\d+$/.test(pinned ?? '')) problems.push(`lingua-runtime: ${name} must be pinned to an exact version`);
  else if (locked !== pinned) problems.push(`lingua-runtime: ${name} locked at ${locked}, package.json pins ${pinned}`);
}

const rootManifest = read('package.json');
for (const name of linguaPackages) {
  const runtimePin = runtimeManifest.dependencies?.[name];
  const rootPin = rootManifest.devDependencies?.[name];
  if (rootPin !== runtimePin) problems.push(`root: ${name} pinned to ${rootPin}, lingua-runtime pins ${runtimePin}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lockfiles ok');
