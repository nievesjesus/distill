import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const [resourcesDir, variant] = process.argv.slice(2);
if (!resourcesDir || !['lite', 'full'].includes(variant)) {
  console.error('usage: check-variant.mjs <appResourcesDir> <lite|full>');
  process.exit(1);
}

const variantPackages = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'onnxruntime-node'];
const asarPath = join(resourcesDir, 'app.asar');
const unpackedRoot = join(resourcesDir, 'app.asar.unpacked');
const problems = [];

if (!existsSync(asarPath)) {
  console.error(`missing ${asarPath}`);
  process.exit(1);
}

const entries = new Set(asar.listPackage(asarPath, { isPack: false }).map((entry) => entry.replaceAll('\\', '/').replace(/^\//, '')));

function hasPackage(name) {
  const prefix = `node_modules/${name}/`;
  const inAsar = [...entries].some((entry) => entry.startsWith(prefix));
  return inAsar || existsSync(join(unpackedRoot, 'node_modules', name));
}

for (const name of variantPackages) {
  const present = hasPackage(name);
  if (variant === 'lite' && present) problems.push(`lite must not contain ${name}`);
  if (variant === 'full' && !present) problems.push(`full must contain ${name}`);
}

const liteparseDir = join(unpackedRoot, 'node_modules', '@llamaindex');
const nativeAddons = existsSync(liteparseDir)
  ? readdirSync(liteparseDir, { recursive: true }).filter((file) => /^liteparse\..+\.node$/.test(file.split(/[\\/]/).pop()))
  : [];
const platformAddon = `liteparse.${process.platform}-${process.arch}`;
if (!nativeAddons.some((file) => file.split(/[\\/]/).pop().startsWith(platformAddon))) {
  problems.push(`app.asar.unpacked has no ${platformAddon}*.node (found: ${nativeAddons.join(', ') || 'none'})`);
}

if (!existsSync(join(resourcesDir, 'tessdata', 'eng.traineddata'))) {
  problems.push('resources/tessdata/eng.traineddata is missing');
}

if (problems.length > 0) {
  console.error(`check-variant ${variant} FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`check-variant ${variant} ok (${nativeAddons.length} liteparse addon file(s), tessdata present)`);
