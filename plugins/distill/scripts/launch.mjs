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

const STDERR_LIMIT = 64 * 1024;
const NOT_PUBLISHED = /ETARGET|E404|No matching version|notarget/i;

export function shouldFallback(code, stderrText, overridden) {
  return code !== 0 && !overridden && NOT_PUBLISHED.test(stderrText);
}

function stdioWithPipedStderr(stdio) {
  const list = stdio === undefined ? ['pipe', 'pipe', 'pipe'] : Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
  const stderrMode = list[2];
  list[2] = 'pipe';
  return { list, forward: stderrMode === 'inherit' };
}

function attempt(npx, spec, args, { stdio, onSpawn, spawnFn, writeStderr }) {
  const { list, forward } = stdioWithPipedStderr(stdio);
  return new Promise((resolve) => {
    const child = spawnFn(npx.command, npxArgs(npx.prefix, spec, args), { stdio: list, windowsHide: true });
    let captured = '';
    child.stderr?.on('data', (chunk) => {
      if (forward) writeStderr(chunk);
      if (captured.length < STDERR_LIMIT) captured += chunk.toString().slice(0, STDERR_LIMIT - captured.length);
    });
    child.on('error', (error) => {
      writeStderr(`distill failed to start: ${error.message}\n`);
      resolve({ code: 1, stderr: '' });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: captured }));
    if (onSpawn) onSpawn(child);
  });
}

export async function launch(args, { stdio, onSpawn, spawnFn = spawn, env = process.env, writeStderr = (text) => process.stderr.write(text) } = {}) {
  if (nodeTooOld(process.versions.node)) {
    writeStderr(`distill needs Node.js 22.12 or newer (found ${process.versions.node})\n`);
    return 1;
  }
  const npx = npxCommand(process.execPath, process.platform, existsSync);
  if (npx.unsupported) {
    writeStderr('distill could not find npx next to Node.js; install Node.js 22.12 or newer from nodejs.org\n');
    return 1;
  }
  const overridden = typeof env.DISTILL_PLUGIN_PACKAGE === 'string' && env.DISTILL_PLUGIN_PACKAGE !== '';
  const spec = packageSpec(env, pluginRoot);
  const options = { stdio, onSpawn, spawnFn, writeStderr };
  const first = await attempt(npx, spec, args, options);
  if (!shouldFallback(first.code, first.stderr, overridden)) return first.code;
  writeStderr(`distill: ${spec} is not on npm yet; using the latest release\n`);
  return (await attempt(npx, 'distill-llm@latest', args, options)).code;
}
