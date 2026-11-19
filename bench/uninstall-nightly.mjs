import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { LABEL, launchdPaths } from './lib/launchd.mjs';

const args = new Set(process.argv.slice(2));
const yes = args.has('--yes');
const dryRun = args.has('--dry-run');

async function confirm(question) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The nightly schedule uses launchd and only works on macOS.');
  const paths = launchdPaths();
  const uid = process.getuid();
  console.log('This will:');
  console.log(`  - Run: launchctl bootout gui/${uid} ${paths.plist} (only if it is loaded)`);
  console.log(`  - Delete ${paths.plist}`);
  console.log('Results and logs are kept.');
  if (dryRun) {
    console.log('Dry run: nothing was changed.');
    return;
  }
  if (!(await confirm('Continue?'))) {
    console.log('Cancelled, nothing was changed.');
    return;
  }
  const loaded = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }).status === 0;
  if (loaded) {
    spawnSync('launchctl', ['bootout', `gui/${uid}`, paths.plist], { stdio: 'inherit' });
    console.log(`Unloaded ${LABEL}`);
  } else {
    console.log(`${LABEL} was not loaded`);
  }
  if (existsSync(paths.plist)) {
    rmSync(paths.plist);
    console.log(`Deleted ${paths.plist}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
