import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

export function packageSpec(env, root) {
  if (typeof env.DISTILL_PLUGIN_PACKAGE === 'string' && env.DISTILL_PLUGIN_PACKAGE !== '') return env.DISTILL_PLUGIN_PACKAGE;
  const manifest = JSON.parse(readFileSync(posix.join(root.replaceAll('\\', '/'), '.claude-plugin', 'plugin.json'), 'utf8'));
  return `distill-llm@${manifest.version}`;
}

export function npxCommand(execPath, platform, exists) {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const cli = windows
    ? path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
    : path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (exists(cli)) return { command: execPath, prefix: [cli] };
  return windows ? { command: 'npx.cmd', prefix: [], unsupported: true } : { command: 'npx', prefix: [] };
}

export function npxArgs(prefix, spec, args) {
  return [...prefix, '-y', '--package', spec, 'distill-llm', ...args];
}

export function nodeTooOld(version) {
  const [major, minor] = version.split('.').map(Number);
  return major < 22 || (major === 22 && minor < 12);
}

export function launch(args, { stdio, onSpawn } = {}) {
  if (nodeTooOld(process.versions.node)) {
    process.stderr.write(`distill needs Node.js 22.12 or newer (found ${process.versions.node})\n`);
    return Promise.resolve(1);
  }
  const npx = npxCommand(process.execPath, process.platform, existsSync);
  if (npx.unsupported) {
    process.stderr.write('distill could not find npx next to Node.js; install Node.js 22.12 or newer from nodejs.org\n');
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(npx.command, npxArgs(npx.prefix, packageSpec(process.env, pluginRoot), args), { stdio, windowsHide: true });
    child.on('error', (error) => {
      process.stderr.write(`distill failed to start: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
    if (onSpawn) onSpawn(child);
  });
}
