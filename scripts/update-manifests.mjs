import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

class ManifestError extends Error {}

function parseScalar(raw) {
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) return undefined;
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw === '' || /^[\[{|>&*!%@`"#]/.test(raw)) return undefined;
  return raw;
}

function parsePair(content) {
  const match = /^([A-Za-z0-9_]+):(?: (.*))?$/.exec(content);
  if (!match || match[2] === undefined) return undefined;
  const value = parseScalar(match[2]);
  return value === undefined ? undefined : [match[1], value];
}

export function parseManifest(text) {
  const manifest = {};
  let current = null;
  let inFiles = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, index) => {
    const fail = () => new ManifestError(`unsupported manifest syntax at line ${index + 1}`);
    if (line === 'files:') {
      if (inFiles || 'files' in manifest) throw fail();
      manifest.files = [];
      inFiles = true;
      return;
    }
    if (/^ {2}- /.test(line) && inFiles) {
      const pair = parsePair(line.slice(4));
      if (!pair) throw fail();
      current = { [pair[0]]: pair[1] };
      manifest.files.push(current);
      return;
    }
    if (/^ {4}\S/.test(line) && inFiles && current) {
      const pair = parsePair(line.slice(4));
      if (!pair || pair[0] in current) throw fail();
      current[pair[0]] = pair[1];
      return;
    }
    if (/^\S/.test(line)) {
      const pair = parsePair(line);
      if (!pair || pair[0] in manifest) throw fail();
      manifest[pair[0]] = pair[1];
      inFiles = false;
      current = null;
      return;
    }
    throw fail();
  });
  return manifest;
}

function formatScalar(key, value) {
  if (typeof value === 'string' && key === 'releaseDate') return `'${value.replaceAll("'", "''")}'`;
  return String(value);
}

export function formatManifest(manifest) {
  const lines = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'files') {
      lines.push('files:');
      for (const file of value) {
        Object.entries(file).forEach(([fileKey, fileValue], index) => {
          lines.push(`${index === 0 ? '  - ' : '    '}${fileKey}: ${formatScalar(fileKey, fileValue)}`);
        });
      }
    } else {
      lines.push(`${key}: ${formatScalar(key, value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function load(path) {
  return parseManifest(readFileSync(path, 'utf8'));
}

function refresh(manifestPath, filePaths) {
  const manifest = load(manifestPath);
  for (const filePath of filePaths) {
    const name = basename(filePath);
    const entry = (manifest.files ?? []).find((file) => file.url === name);
    if (!entry) throw new ManifestError(`no files entry for ${name} in ${manifestPath}`);
    const bytes = readFileSync(filePath);
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    entry.sha512 = sha512;
    entry.size = bytes.length;
    delete entry.blockMapSize;
    if (manifest.path === name) manifest.sha512 = sha512;
  }
  writeFileSync(manifestPath, formatManifest(manifest));
  return manifestPath;
}

function merge(outPath, inputPaths) {
  if (inputPaths.length === 0) throw new ManifestError('merge needs at least one input manifest');
  const inputs = inputPaths.map(load);
  const [first] = inputs;
  for (const input of inputs) {
    if (input.version !== first.version) {
      throw new ManifestError(`version mismatch: ${first.version} vs ${input.version}`);
    }
  }
  const files = [];
  for (const input of inputs) {
    for (const file of input.files ?? []) {
      const existing = files.find((known) => known.url === file.url);
      if (!existing) files.push(file);
      else if (existing.sha512 !== file.sha512) throw new ManifestError(`conflicting sha512 for ${file.url}`);
    }
  }
  const merged = {};
  for (const [key, value] of Object.entries(first)) merged[key] = key === 'files' ? files : value;
  if (!('files' in merged)) merged.files = files;
  const dates = inputs.map((input) => input.releaseDate).filter((date) => date !== undefined);
  if (dates.length > 0) {
    merged.releaseDate = dates.reduce((latest, date) => (Date.parse(date) > Date.parse(latest) ? date : latest));
  }
  writeFileSync(outPath, formatManifest(merged));
  return outPath;
}

function main(argv) {
  const [command, target, ...rest] = argv;
  try {
    if (command === 'refresh' && target && rest.length > 0) console.log(`wrote ${refresh(target, rest)}`);
    else if (command === 'merge' && target && rest.length > 0) console.log(`wrote ${merge(target, rest)}`);
    else throw new ManifestError('usage: update-manifests.mjs refresh <manifest.yml> <file>... | merge <out.yml> <in.yml>...');
  } catch (error) {
    console.error(error instanceof ManifestError || error?.code === 'ENOENT' ? error.message : error);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
