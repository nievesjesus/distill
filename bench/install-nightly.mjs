import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { LABEL, launchdPaths, plistFor } from './lib/launchd.mjs';

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
  const lines = [
    `Write ${paths.plist} (runs ${paths.script} every day at 02:30 local time, RunAtLoad off)`,
    `Create ${paths.logDir} for the logs`,
    `Run: launchctl bootout gui/${uid} ${paths.plist} (only if it is already loaded)`,
    `Run: launchctl bootstrap gui/${uid} ${paths.plist}`,
    'Each night it spends up to $15 of your Claude Code usage (DISTILL_BENCH_BUDGET changes it).',
  ];
  console.log('This will:');
  for (const line of lines) console.log(`  - ${line}`);
  if (dryRun) {
    console.log('Dry run: nothing was changed.');
    return;
  }
  if (!(await confirm('Continue?'))) {
    console.log('Cancelled, nothing was changed.');
    return;
  }
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(dirname(paths.plist), { recursive: true });
  chmodSync(paths.script, 0o755);
  const loaded = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }).status === 0;
  if (loaded) {
    spawnSync('launchctl', ['bootout', `gui/${uid}`, paths.plist], { stdio: 'inherit' });
    console.log(`Unloaded the previous ${LABEL}`);
  }
  writeFileSync(paths.plist, plistFor(paths));
  console.log(`Wrote ${paths.plist}`);
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, paths.plist], { stdio: 'inherit' });
  if (boot.status !== 0) throw new Error(`launchctl bootstrap failed with exit code ${boot.status}`);
  console.log(`Loaded ${LABEL}. First run tonight at 02:30; logs in ${paths.logDir}. Remove it with: npm run bench:uninstall-nightly`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
