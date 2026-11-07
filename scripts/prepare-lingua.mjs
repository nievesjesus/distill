import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../lingua-runtime/', import.meta.url));
const target = fileURLToPath(new URL('../build/lingua/', import.meta.url));
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error('run this through npm (npm run prepare:lingua) so npm_execpath is set');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of ['package.json', 'package-lock.json']) copyFileSync(source + file, target + file);
execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--include=peer', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
console.log('lingua runtime ready in build/lingua');
