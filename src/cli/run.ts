import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { isLoopbackHost } from '../core/loopback';
import { handleClaudePreToolUse } from '../hooks/claude';
import { convertCached } from '../hooks/cache';
import { readIfExists, realTarget, writeAtomic } from '../hooks/atomic';
import { findOnPath, hookCommand } from '../hooks/command';
import { lineDiff } from '../hooks/diff';
import { normalizeSettings, planClaudeInstall, planClaudeUninstall } from '../hooks/install-claude';
import { isOwnOpencodePlugin, opencodePluginPath, planOpencodeInstall } from '../hooks/install-opencode';
import { isHookConvertible } from '../hooks/supported';
import type { Distiller } from '../node/distill';
import { cwdResolver, resolveRoots, rootResolver } from '../mcp/roots';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInside } from '../node/inside';
import { readLiteparseVersion } from '../node/versions';
import { parseBoosters, parseRate, runConvert } from './convert';
import type { ConvertOptions } from './convert';

type Server = { url: string; close(): Promise<void> };

export interface CliDeps {
  startServer?: (opts: { port: number; host: string; maxBytes: number; allowedHosts: string[] }) => Promise<Server>;
  openUrl?: (url: string) => void;
  openDistiller?: (maxBytes?: number) => Promise<Distiller>;
  connectStdio?: (server: McpServer, onClose: () => void) => Promise<void>;
  serveMcpHttp?: (opts: { port: number; host: string; allowedHosts: string[]; createServer: () => McpServer }) => Promise<Server>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  exit?: (code: number) => never;
  handleSignals?: boolean;
  env?: Record<string, string | undefined>;
  readStdin?: () => Promise<string>;
  cacheDir?: string;
  homeDir?: string;
  cwd?: string;
  which?: (bin: string) => string | null;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  isGitIgnored?: (cwd: string, file: string) => boolean | null;
}

function gitCheckIgnore(cwd: string, file: string): boolean | null {
  const result = spawnSync('git', ['check-ignore', '-q', file], { cwd, stdio: 'ignore' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

const BYTES_PER_MB = 1024 * 1024;

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface HooksOptions {
  claude?: boolean;
  opencode?: boolean;
  project?: boolean;
  yes?: boolean;
}

export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    try {
      return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
    } catch {
      dir = dirname(dir);
    }
  }
  return '0.0.0';
}

function parseHostList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new InvalidArgumentError('must be an integer between 0 and 65535');
  }
  return Number(value);
}

function parseMaxSize(value: string): number {
  const mb = Number(value);
  if (value.trim() === '' || !Number.isFinite(mb) || mb <= 0) {
    throw new InvalidArgumentError('must be a positive number of megabytes');
  }
  return mb;
}

export interface OpenCommand {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export function openCommand(url: string, platform: NodeJS.Platform = process.platform): OpenCommand {
  if (platform === 'darwin') return { file: 'open', args: [url], windowsVerbatimArguments: false };
  if (platform === 'win32') {
    return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url], windowsVerbatimArguments: true };
  }
  return { file: 'xdg-open', args: [url], windowsVerbatimArguments: false };
}

export function openInBrowser(url: string): void {
  const command = openCommand(url);
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  child.on('error', () => {});
  child.unref();
}

interface McpOptions {
  http?: boolean;
  port: number;
  host: string;
  root?: string[];
  allowedHosts?: string[];
}

interface WebOptions {
  port: number;
  host: string;
  maxSize: number;
  open: boolean;
  allowedHosts?: string[];
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<void> {
  const startServer = deps.startServer ?? (async (opts) => (await import('../server/start')).startServer(opts));
  const openUrl = deps.openUrl ?? openInBrowser;
  const openDistiller = deps.openDistiller ?? (async (maxBytes) => (await import('../node/distill')).openDistiller(maxBytes));
  const connectStdio = deps.connectStdio ?? (async (server, onClose) => (await import('../mcp/stdio')).connectStdio(server, onClose));
  const serveMcpHttp = deps.serveMcpHttp ?? (async (opts) => (await import('../mcp/http')).serveMcpHttp(opts));
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const handleSignals = deps.handleSignals ?? true;
  const env = deps.env ?? process.env;
  const readStdin = deps.readStdin ?? defaultReadStdin;
  const cacheDir = deps.cacheDir ?? join(homedir(), '.cache', 'distill-llm');
  const homeDir = deps.homeDir ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const which = deps.which ?? ((bin: string) => findOnPath(bin, env.PATH));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? defaultPrompt;
  const isGitIgnored = deps.isGitIgnored ?? gitCheckIgnore;

  const program = new Command();
  program
    .name('distill-llm')
    .version(readVersion())
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout(text.trimEnd()),
      writeErr: () => {},
      outputError: (text) => stderr(text.trim().split('\n')[0]),
    });

  program
    .command('web', { isDefault: true })
    .description('Start the local web app')
    .option('--port <n>', 'port to listen on', parsePort, 4321)
    .option('--host <h>', 'host to bind', '127.0.0.1')
    .option('--max-size <mb>', 'maximum file size in MB', parseMaxSize, 100)
    .option('--no-open', 'do not open the browser')
    .option('--allowed-hosts <list>', 'comma-separated hostnames accepted when bound to a non-loopback host (".example.com" allows subdomains)', parseHostList)
    .action(async (options: WebOptions) => {
      let server: Server;
      try {
        server = await startServer({
          port: options.port,
          host: options.host,
          maxBytes: Math.round(options.maxSize * BYTES_PER_MB),
          allowedHosts: options.allowedHosts ?? parseHostList(env.DISTILL_ALLOWED_HOSTS ?? ''),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          stderr(`Port ${options.port} is in use. Try --port ${options.port + 1}`);
        } else {
          stderr(`Failed to start distill: ${error instanceof Error ? error.message : String(error)}`);
        }
        exit(1);
        return;
      }

      stdout(`distill running at ${server.url}`);
      if (!isLoopbackHost(options.host)) {
        stderr(`Warning: listening on ${options.host} — anyone on your network can reach distill`);
      }
      if (options.open) openUrl(server.url);

      if (handleSignals) {
        let closing = false;
        const shutdown = () => {
          if (closing) {
            exit(1);
            return;
          }
          closing = true;
          server.close().then(
            () => exit(0),
            () => exit(1),
          );
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      }
    });

  program
    .command('convert')
    .description('Convert documents to optimized Markdown')
    .argument('<files...>', 'files to convert')
    .option('--out <dir>', 'write the Markdown files into this directory')
    .option('--no-optimize', 'skip all boosters')
    .option('--boosters <list>', 'comma-separated boosters: dedupe, media, tables, ws', parseBoosters)
    .option('--lingua', 'compress with LLMLingua-2')
    .option('--rate <n>', 'LLMLingua-2 keep rate (0..1)', parseRate)
    .option('--json', 'print a JSON array with the results')
    .option('--stdout', 'print the Markdown of a single file instead of writing it')
    .option('--max-size <mb>', 'maximum file size in MB', parseMaxSize, 100)
    .action(async (files: string[], options: ConvertOptions) => {
      const code = await runConvert(files, options, { stdout, stderr, openDistiller });
      if (code !== 0) exit(code);
    });

  program
    .command('mcp')
    .description('Start the MCP server (stdio by default)')
    .option('--http', 'serve Streamable HTTP instead of stdio')
    .option('--port <n>', 'port to listen on (with --http)', parsePort, 4322)
    .option('--host <h>', 'host to bind (with --http)', '127.0.0.1')
    .option('--root <dir>', 'directory the HTTP server may read from (repeatable, default: cwd)', (value: string, previous: string[] = []) => [...previous, value])
    .option('--allowed-hosts <list>', 'comma-separated hostnames accepted when bound to a non-loopback host', parseHostList)
    .action(async (options: McpOptions) => {
      let distiller: Distiller;
      try {
        distiller = await openDistiller();
      } catch (error) {
        stderr(`Failed to start distill: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
        return;
      }
      const { createMcpServer } = await import('../mcp/server');
      const build = (resolvePath: (path: string) => Promise<string>) => () =>
        createMcpServer({ distiller, health: () => distiller.health(), resolvePath });

      if (!options.http) {
        await connectStdio(build(cwdResolver(cwd))(), () => {
          distiller.close();
          exit(0);
        });
        return;
      }

      try {
        await resolveRoots(options.root ?? [cwd], cwd);
      } catch (error) {
        distiller.close();
        stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
        return;
      }

      let server: Server;
      try {
        server = await serveMcpHttp({
          port: options.port,
          host: options.host,
          allowedHosts: options.allowedHosts ?? parseHostList(env.DISTILL_ALLOWED_HOSTS ?? ''),
          createServer: build(rootResolver(options.root ?? [cwd], cwd)),
        });
      } catch (error) {
        distiller.close();
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          stderr(`Port ${options.port} is in use. Try --port ${options.port + 1}`);
        } else {
          stderr(`Failed to start distill: ${error instanceof Error ? error.message : String(error)}`);
        }
        exit(1);
        return;
      }
      stderr(`distill MCP at ${server.url}`);
      if (!isLoopbackHost(options.host)) {
        stderr(`Warning: listening on ${options.host} — anyone on your network can reach distill`);
      }
      if (handleSignals) {
        const shutdown = () => {
          server.close().then(
            () => {
              distiller.close();
              exit(0);
            },
            () => exit(1),
          );
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      }
    });

  const hook = program.command('hook').description('Runtimes for agent hooks');

  const closeQuietly = (distiller: Distiller | null): void => {
    try {
      distiller?.close();
    } catch {}
  };

  const describeError = (error: unknown): string =>
    (error as { code?: unknown })?.code !== undefined && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : error instanceof Error
        ? error.message
        : String(error);

  const convertViaCache = async (getDistiller: () => Promise<Distiller>, absPath: string): Promise<string> =>
    (await convertCached(absPath, {
      getDistiller,
      cacheDir,
      version: readVersion(),
      liteparseVersion: readLiteparseVersion(),
    })).mdPath;

  hook
    .command('claude')
    .description('Claude Code PreToolUse hook: reads JSON on stdin')
    .allowExcessArguments()
    .allowUnknownOption()
    .action(async () => {
      let distiller: Distiller | null = null;
      const getDistiller = async (): Promise<Distiller> => (distiller ??= await openDistiller());
      try {
        let payload: unknown;
        try {
          payload = JSON.parse(await readStdin());
        } catch {
          stderr('distill hook: invalid hook input, passing through');
          exit(0);
          return;
        }
        if (env.DISTILL_HOOK === 'off') {
          exit(0);
          return;
        }
        const result = await handleClaudePreToolUse(payload, async (absPath) => {
          try {
            return await convertViaCache(getDistiller, absPath);
          } catch (error) {
            stderr(`distill hook: ${describeError(error)}`);
            throw error;
          }
        }, { homeDir, projectDir: env.CLAUDE_PROJECT_DIR });
        if (result !== null) stdout(JSON.stringify(result));
      } catch (error) {
        stderr(`distill hook: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        closeQuietly(distiller as Distiller | null);
      }
      exit(0);
    });

  hook
    .command('convert')
    .description('Convert a document to cached Markdown and print its path as JSON')
    .argument('<file>', 'file to convert')
    .action(async (file: string) => {
      if (!isHookConvertible(file)) {
        exit(1);
        return;
      }
      let distiller: Distiller | null = null;
      const getDistiller = async (): Promise<Distiller> => (distiller ??= await openDistiller());
      try {
        const absPath = isAbsolute(file) ? file : resolve(cwd, file);
        const path = await convertViaCache(getDistiller, absPath);
        stdout(JSON.stringify({ path }));
      } catch (error) {
        stderr(`distill hook: ${error instanceof Error ? error.message : String(error)}`);
        closeQuietly(distiller);
        exit(1);
        return;
      }
      closeQuietly(distiller);
    });

  const hooks = program.command('hooks').description('Install or remove the agent hooks');

  type Target = 'claude' | 'opencode';

  const applyChange = async (path: string, label: string, before: string | null, next: string | null, options: HooksOptions, note?: string): Promise<boolean> => {
    stdout(`File: ${label}`);
    if (note !== undefined) stdout(note);
    for (const line of lineDiff(before ?? '', next ?? '')) stdout(line);
    if (options.yes !== true) {
      if (!isTTY) {
        stderr('Refusing to write without confirmation. Re-run with --yes.');
        exit(1);
        return false;
      }
      const answer = (await prompt('Apply? [y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        stdout('Aborted.');
        return true;
      }
    }
    try {
      if (next === null) rmSync(path, { force: true });
      else writeAtomic(path, next);
    } catch (error) {
      stderr(`Could not write ${path}: ${errorMessage(error)}`);
      exit(1);
      return false;
    }
    stdout(next === null ? `Removed ${path}` : `Wrote ${path}`);
    return true;
  };

  const processTarget = async (target: Target, action: 'install' | 'uninstall', options: HooksOptions, command: string): Promise<boolean> => {
    const location = { home: homeDir, cwd, project: options.project === true };
    const path =
      target === 'claude'
        ? join(location.project ? cwd : homeDir, '.claude', location.project ? 'settings.local.json' : 'settings.json')
        : opencodePluginPath(location);
    let label = path;
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {}
    let resolved: string;
    try {
      if (isLink) realpathSync(path);
      resolved = realTarget(path);
    } catch {
      stderr(`Refusing to follow ${isLink ? 'dangling symlink' : 'unresolvable path'} ${path}.`);
      exit(1);
      return false;
    }
    if (location.project) {
      const root = realpathSync(cwd);
      if (!isInside(resolved, root)) {
        stderr(`Refusing to write ${path}: it links outside the project (${resolved}).`);
        exit(1);
        return false;
      }
    }
    if (resolved !== path) label = `${path} -> ${resolved}`;
    let current: string | null;
    try {
      current = readIfExists(path);
    } catch (error) {
      stderr(`Could not read ${path}: ${errorMessage(error)}`);
      exit(1);
      return false;
    }

    if (action === 'uninstall' && current === null) {
      stdout('Nothing to remove.');
      return true;
    }

    if (target === 'opencode') {
      if (current !== null && !isOwnOpencodePlugin(current)) {
        if (action === 'uninstall') {
          stdout(`${path} was not created by distill; leaving it.`);
          return true;
        }
        stderr(`${path} exists and was not created by distill; refusing to overwrite it.`);
        exit(1);
        return false;
      }
      if (action === 'install') {
        const plan = planOpencodeInstall(current, command);
        if (!plan.changed) {
          stdout(`Already installed: ${path}`);
          return true;
        }
        return applyChange(path, label, current, plan.next, options);
      }
      return applyChange(path, label, current, null, options);
    }

    let plan: { next: string; changed: boolean };
    let baseline: string | null = current;
    let note: string | undefined;
    try {
      plan = action === 'install' ? planClaudeInstall(current, command) : planClaudeUninstall(current as string);
      if (current !== null) {
        baseline = normalizeSettings(current);
        if (current.trim() !== '' && baseline !== current) note = `Note: ${path} will be re-indented with 2 spaces.`;
      }
    } catch (error) {
      stderr(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
      exit(1);
      return false;
    }
    if (!plan.changed) {
      stdout(action === 'install' ? `Already installed: ${path}` : 'Nothing to remove.');
      return true;
    }
    const applied = await applyChange(path, label, baseline, plan.next, options, note);
    if (applied && action === 'install' && location.project) {
      let written: string | null = null;
      try {
        written = readIfExists(path);
      } catch {}
      if (written !== null && written !== current && isGitIgnored(cwd, join('.claude', 'settings.local.json')) === false) {
        stdout('Tip: add .claude/settings.local.json to .gitignore so it stays personal.');
      }
    }
    return applied;
  };

  const runHooksAction = async (action: 'install' | 'uninstall', options: HooksOptions): Promise<void> => {
    const targets: Target[] = [];
    if (options.claude) targets.push('claude');
    if (options.opencode) targets.push('opencode');
    if (targets.length === 0) {
      stderr('Choose a target: --claude or --opencode.');
      exit(2);
      return;
    }
    const command = hookCommand({ which, version: readVersion(), npmCommand: env.npm_command });
    if (action === 'install') {
      stdout(`Hook command: ${command}`);
      if (command !== 'distill-llm') stdout('Tip: npm i -g distill-llm makes the hook start faster.');
    }
    for (const target of targets) {
      if (!(await processTarget(target, action, options, command))) return;
    }
  };

  for (const action of ['install', 'uninstall'] as const) {
    hooks
      .command(action)
      .description(action === 'install' ? 'Install the hook for an agent' : 'Remove the hook for an agent')
      .option('--claude', 'Claude Code (PreToolUse hook in settings.json, or settings.local.json with --project)')
      .option('--opencode', 'OpenCode (plugin file)')
      .option('--project', 'use the current project instead of your home directory')
      .option('--yes', 'apply without asking')
      .action((options: HooksOptions) => runHooksAction(action, options));
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (argv[0] === 'hook' && argv[1] === 'claude') {
        exit(0);
        return;
      }
      exit(error.exitCode === 0 ? 0 : 2);
      return;
    }
    throw error;
  }
}
