import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function update(root, relative, version, apply) {
  const path = join(root, relative);
  const before = readFileSync(path, 'utf8');
  const json = JSON.parse(before);
  apply(json, version);
  const after = serialize(json);
  if (after === before) return null;
  writeFileSync(path, after);
  return relative;
}

export function syncVersions(root) {
  const { version } = read(join(root, 'package.json'));
  const changed = [
    update(root, 'server.json', version, (json, v) => {
      json.version = v;
      for (const entry of json.packages ?? []) entry.version = v;
    }),
    update(root, 'plugins/distill/.claude-plugin/plugin.json', version, (json, v) => {
      json.version = v;
    }),
  ];
  return changed.filter((file) => file !== null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of syncVersions(process.cwd())) console.log(`synced ${file}`);
}
