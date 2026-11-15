import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^v(\d+\.\d+\.\d+)$/;

function compare(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function decideTag(version, tags) {
  const tag = `v${version}`;
  if (!VERSION.test(version)) return { create: false, tag, reason: 'not a release version' };
  if (tags.includes(tag)) return { create: false, tag, reason: 'tag exists' };
  const newer = tags.find((existing) => TAG.test(existing) && compare(TAG.exec(existing)[1], version) > 0);
  if (newer) return { create: false, tag, reason: `older than ${newer}` };
  return { create: true, tag, reason: 'new release' };
}

function main(argv) {
  const [version, ...tags] = argv;
  if (!version) {
    console.error('usage: release-tag.mjs <version> [tag...]');
    process.exit(1);
  }
  const decision = decideTag(version, tags);
  console.log(JSON.stringify(decision));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `create=${decision.create}\ntag=${decision.tag}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
