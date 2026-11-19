import { corpusDir } from './lib/paths.mjs';
import { fetchDoc } from './lib/fetch-doc.mjs';
import { loadCorpus } from './lib/tasks.mjs';

async function main() {
  const dir = corpusDir();
  const docs = loadCorpus().filter((doc) => typeof doc.local !== 'string');
  let failed = 0;
  for (const doc of docs) {
    const result = await fetchDoc(doc, dir);
    if (result.status === 'error') {
      failed += 1;
      console.error(`${doc.id}: ${result.error}`);
    } else {
      console.log(`${doc.id}: ${result.status}`);
    }
  }
  console.log(`${docs.length - failed}/${docs.length} documents ready in ${dir}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
