import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { isLoopbackHost } from '../core/loopback';
import { handleClaudePreToolUse } from '../hooks/claude';
import { convertCached } from '../hooks/cache';
import { readIfExists, realTarget, writeAtomic } from '../hooks/atomic';
import { findOnPath, hookCommand } from '../hooks/command';
import { claudeSkillMarkdown, claudeSkillPath, isOwnSkill } from '../hooks/claude-skill';
import { lineDiff } from '../hooks/diff';
import { normalizeSettings, planClaudeInstall, planClaudeUninstall } from '../hooks/install-claude';
import { isOwnOpencodePlugin, opencodePluginPath, planOpencodeInstall } from '../hooks/install-opencode';
import { isHookConvertible } from '../hooks/supported';
import { agentOptionKey, AGENTS, failureHint, renderStatus, statusRows } from '../agents';
import { defaultExec } from '../agents/exec';
import { commandParts } from '../agents/json-config';
import type { Exec } from '../agents/exec';
import { agentsSkillMarkdown, agentsSkillPath, hermesSkillPath } from '../agents/skill';
import type { AgentContext, AgentModule, Step } from '../agents/types';
import type { Distiller } from '../node/distill';
import { cwdResolver, resolveRoots, rootResolver } from '../mcp/roots';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInside } from '../node/inside';
import { readStats, recordUsage, renderStats, summarize } from '../node/stats';
import { readLiteparseVersion } from '../node/versions';
import { findPackageRoot } from '../node/lingua';
import { createUpdateChecker, detectInstallMethod } from '../node/update-check';
import type { UpdateChecker } from '../node/update-check';
import { cacheDirFromEnv } from '../node/cache-dir';
import { createGlobalUpdater } from '../node/update-install';
import type { GlobalUpdater } from '../node/update-install';
import type { InstallMethod, UpdateCheck } from '../core/types';
import { parseBoosters, parsePositiveInt, parseRate, runConvert, runOutline } from './convert';
import type { ConvertOptions, OutlineOptions } from './convert';

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
  exec?: Exec;
  mcpLauncher?: { bin: string; args: string[] };
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  isGitIgnored?: (cwd: string, file: string) => boolean | null;
  updateChecker?: UpdateChecker;
  globalUpdater?: GlobalUpdater | null;
}

function gitCheckIgnore(cwd: string, file: string): boolean | null {
  const result = spawnSync('git', ['check-ignore', '-q', file], { cwd, stdio: 'ignore' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

const BYTES_PER_MB = 1024 * 1024;

function parsePrice(value: string): number {
  const price = Number(value);
  if (value.trim() === '' || !Number.isFinite(price) || price < 0) throw new InvalidArgumentError('must be a non-negative number');
  return price;
}

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
  dryRun?: boolean;
}

interface AgentsOptions extends HooksOptions {
  codex?: boolean;
  gemini?: boolean;
  cursor?: boolean;
  claudeDesktop?: boolean;
  hermes?: boolean;
  openclaw?: boolean;
  all?: boolean;
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

const NOTICE_TIMEOUT_MS = 1500;

function updateCommand(method: InstallMethod, latest: string): string | null {
  switch (method) {
    case 'npm-global':
      return `npm install -g distill-llm@${latest}`;
    case 'npx':
      return 'npx distill-llm@latest';
    case 'docker':
      return 'docker pull ghcr.io/nievesjesus/distill';
    case 'source':
      return 'git pull && npm ci && npm run build';
    default:
      return null;
  }
}

export function updateNotice(info: UpdateCheck): string | null {
  if (!info.available || info.latest === null) return null;
  const hint = info.method === 'npm-global' ? 'distill-llm update' : updateCommand(info.method, info.latest);
  const head = `distill-llm ${info.latest} is available (you have ${info.current}).`;
  return hint === null ? `${head} Open the desktop app to update it.` : `${head} Run: ${hint}`;
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
  const homeDir = deps.homeDir ?? homedir();
  const cacheDir = deps.cacheDir ?? cacheDirFromEnv(env) ?? join(homeDir, '.cache', 'distill-llm');
  const cwd = deps.cwd ?? process.cwd();
  const which = deps.which ?? ((bin: string) => findOnPath(bin, env.PATH));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? defaultPrompt;
  const isGitIgnored = deps.isGitIgnored ?? gitCheckIgnore;
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;

  let checker = deps.updateChecker;
  const getChecker = (): UpdateChecker => {
    if (checker) return checker;
    const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url))) ?? process.cwd();
    checker = createUpdateChecker({
      current: readVersion(),
      method: detectInstallMethod({ packageRoot, env }),
      cacheDir,
      env,
    });
    return checker;
  };
  let updater = deps.globalUpdater;
  const getUpdater = (): GlobalUpdater => {
    if (updater) return updater;
    const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url))) ?? process.cwd();
    updater = createGlobalUpdater({ packageRoot });
    return updater;
  };

  const showNotice = async (): Promise<void> => {
    try {
      const timeout = new Promise<null>((done) => setTimeout(() => done(null), NOTICE_TIMEOUT_MS).unref());
      const info = await Promise.race([getChecker().check(), timeout]);
      const line = info === null ? null : updateNotice(info);
      if (line !== null) stderr(line);
    } catch {
      return;
    }
  };

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
      void showNotice();

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
    .option('--offset <n>', 'with --stdout: first line to print (1-based)', parsePositiveInt)
    .option('--limit <n>', 'with --stdout: number of lines to print', parsePositiveInt)
    .option('--max-tokens <n>', 'with --stdout: print an index and the first lines when the document is larger than this', parsePositiveInt)
    .option('--max-size <mb>', 'maximum file size in MB', parseMaxSize, 100)
    .action(async (files: string[], options: ConvertOptions) => {
      const code = await runConvert(files, options, {
        stdout,
        stderr,
        openDistiller,
        savingsNote: env.DISTILL_NO_SAVINGS_NOTE !== '1',
        recordUsage: (kind, savings) => recordUsage({ source: 'cli', kind, savings }, { cacheDir, env }),
      });
      if (isTTY && !options.json && !options.stdout) await showNotice();
      if (code !== 0) exit(code);
    });

  program
    .command('outline')
    .description('Print an index of a document with line ranges and token counts')
    .argument('<file>', 'file to index')
    .option('--json', 'print the index as JSON')
    .option('--max-size <mb>', 'maximum file size in MB', parseMaxSize, 100)
    .action(async (file: string, options: OutlineOptions) => {
      const code = await runOutline(file, options, { stdout, stderr, openDistiller });
      if (code !== 0) exit(code);
    });

  program
    .command('stats')
    .description('Show how many tokens distill has saved on this machine')
    .option('--json', 'print the summary as JSON')
    .option('--price <usd>', 'value saved tokens at this price in USD per million input tokens', parsePrice)
    .action((options: { json?: boolean; price?: number }) => {
      const summary = summarize(readStats(cacheDir), new Date());
      stdout(options.json ? JSON.stringify(summary) : renderStats(summary, options.price === undefined ? {} : { price: options.price }));
    });

  program
    .command('update')
    .description('Check for a newer distill-llm and update it')
    .option('--yes', 'install without asking when installed globally with npm')
    .action(async (options: { yes?: boolean }) => {
      let info: UpdateCheck;
      try {
        info = await getChecker().check({ force: true });
      } catch (error) {
        stderr(`Could not check for updates: ${errorMessage(error)}`);
        exit(1);
        return;
      }
      if (info.latest === null) {
        stderr('Could not reach the npm registry.');
        exit(1);
        return;
      }
      if (!info.available) {
        stdout(`distill-llm ${info.current} is up to date.`);
        return;
      }
      const latest = info.latest;
      stdout(`distill-llm ${latest} is available (you have ${info.current}).`);
      if (info.method === 'desktop') {
        stdout('Open the desktop app to update it.');
        return;
      }
      const command = updateCommand(info.method, latest) as string;
      if (info.method !== 'npm-global') {
        stdout(`Run: ${command}`);
        return;
      }
      let confirmed = options.yes === true;
      if (!confirmed && isTTY) {
        const answer = (await prompt('Update now? [y/N] ')).trim().toLowerCase();
        confirmed = answer === 'y' || answer === 'yes';
      }
      if (!confirmed) {
        if (!isTTY) stdout(`Run: ${command}`);
        return;
      }
      const globalUpdater = getUpdater();
      await globalUpdater.install(latest);
      const result = globalUpdater.status();
      if (result.state === 'failed') {
        stderr(result.error ?? 'Update failed.');
        exit(1);
        return;
      }
      stdout(`Updated to ${latest}.`);
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
      const maxResultTokens = /^\d+$/.test(env.DISTILL_MCP_MAX_TOKENS ?? '') && Number(env.DISTILL_MCP_MAX_TOKENS) > 0 ? Number(env.DISTILL_MCP_MAX_TOKENS) : undefined;
      const build = (resolvePath: (path: string) => Promise<string>) => () =>
        createMcpServer({
          distiller,
          health: () => distiller.health(),
          resolvePath,
          savingsNote: env.DISTILL_NO_SAVINGS_NOTE !== '1',
          recordUsage: (kind, savings) => recordUsage({ source: 'mcp', kind, savings }, { cacheDir, env }),
          ...(maxResultTokens === undefined ? {} : { maxResultTokens }),
        });

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

  const indexMinTokens = (raw: string | undefined): number | undefined => {
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
    return Number(raw.trim());
  };

  const convertViaCache = (getDistiller: () => Promise<Distiller>, absPath: string) =>
    convertCached(absPath, {
      getDistiller,
      cacheDir,
      version: readVersion(),
      liteparseVersion: readLiteparseVersion(),
    });

  hook
    .command('claude')
    .description('Claude Code PreToolUse hook: reads JSON on stdin')
    .option('--plugin', 'running from the Claude Code plugin')
    .allowExcessArguments()
    .allowUnknownOption()
    .action(async (options: { plugin?: boolean }) => {
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
            const converted = await convertViaCache(getDistiller, absPath);
            const markdown = readFileSync(converted.mdPath, 'utf8');
            return converted.savings === null ? { path: converted.mdPath, markdown } : { path: converted.mdPath, savings: converted.savings, markdown };
          } catch (error) {
            stderr(`distill hook: ${describeError(error)}`);
            throw error;
          }
        }, { homeDir, cacheDir, projectDir: env.CLAUDE_PROJECT_DIR, plugin: options.plugin === true, savingsNote: env.DISTILL_NO_SAVINGS_NOTE !== '1', indexMinTokens: indexMinTokens(env.DISTILL_INDEX_MIN_TOKENS), recordUsage: (path, savings) => recordUsage({ source: 'hook', kind: extname(path).slice(1).toUpperCase() || 'unknown', savings }, { cacheDir, env }) });
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
        const { mdPath: path } = await convertViaCache(getDistiller, absPath);
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

  let collectFailures = false;
  let stepFailed = false;
  const failExit = (code: number): void => {
    if (collectFailures) stepFailed = true;
    else exit(code);
  };

  const confirmApply = async (options: HooksOptions): Promise<boolean | null> => {
    if (options.yes === true) return true;
    if (!isTTY) {
      stderr('Refusing to write without confirmation. Re-run with --yes.');
      exit(1);
      return null;
    }
    const answer = (await prompt('Apply? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      stdout('Aborted.');
      return false;
    }
    return true;
  };

  const applyChange = async (path: string, label: string, before: string | null, next: string | null, options: HooksOptions, note?: string): Promise<boolean> => {
    stdout(`File: ${label}`);
    if (note !== undefined) stdout(note);
    for (const line of lineDiff(before ?? '', next ?? '')) stdout(line);
    if (options.dryRun === true) return true;
    const confirmed = await confirmApply(options);
    if (confirmed === null) return false;
    if (!confirmed) return true;
    try {
      if (next === null) rmSync(path, { force: true });
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeAtomic(path, next);
      }
    } catch (error) {
      stderr(`Could not write ${path}: ${errorMessage(error)}`);
      failExit(1);
      return false;
    }
    stdout(next === null ? `Removed ${path}` : `Wrote ${path}`);
    return true;
  };

  const resolveTargetPath = (path: string, project: boolean): string | null => {
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
      failExit(1);
      return null;
    }
    if (project) {
      const root = realpathSync(cwd);
      if (!isInside(resolved, root)) {
        stderr(`Refusing to write ${path}: it links outside the project (${resolved}).`);
        failExit(1);
        return null;
      }
    }
    return resolved;
  };

  const processSkillAt = async (path: string, markdown: string, action: 'install' | 'uninstall', options: HooksOptions): Promise<boolean> => {
    const project = options.project === true;
    const resolved = resolveTargetPath(path, project);
    if (resolved === null) return false;
    const label = resolved !== path ? `${path} -> ${resolved}` : path;
    let current: string | null;
    try {
      current = readIfExists(path);
    } catch (error) {
      stderr(`Could not read ${path}: ${errorMessage(error)}`);
      failExit(1);
      return false;
    }
    if (current === null) {
      if (action === 'uninstall') return true;
      return applyChange(path, label, null, markdown, options);
    }
    if (!isOwnSkill(current)) {
      stdout(`${path} exists and was not created by distill; leaving it.`);
      return true;
    }
    if (action === 'install') {
      if (markdown === current) {
        stdout(`Already installed: ${path}`);
        return true;
      }
      return applyChange(path, label, current, markdown, options);
    }
    const removed = await applyChange(path, label, current, null, options);
    if (removed && options.dryRun !== true) {
      try {
        rmdirSync(dirname(path));
      } catch {}
    }
    return removed;
  };

  const processSkill = (action: 'install' | 'uninstall', options: HooksOptions, command: string): Promise<boolean> =>
    processSkillAt(claudeSkillPath(options.project === true ? cwd : homeDir), claudeSkillMarkdown(command), action, options);

  const processTarget = async (target: Target, action: 'install' | 'uninstall', options: HooksOptions, command: string): Promise<boolean> => {
    const settingsOk = await processSettingsTarget(target, action, options, command);
    if (!settingsOk || target !== 'claude') return settingsOk;
    return processSkill(action, options, command);
  };

  const processSettingsTarget = async (target: Target, action: 'install' | 'uninstall', options: HooksOptions, command: string): Promise<boolean> => {
    const location = { home: homeDir, cwd, project: options.project === true };
    const path =
      target === 'claude'
        ? join(location.project ? cwd : homeDir, '.claude', location.project ? 'settings.local.json' : 'settings.json')
        : opencodePluginPath(location);
    const resolved = resolveTargetPath(path, location.project);
    if (resolved === null) return false;
    const label = resolved !== path ? `${path} -> ${resolved}` : path;
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

  const agents = program.command('agents').description('Install or remove distill for other coding agents');

  const resolveLauncher = (command: string): { bin: string; args: string[] } => {
    if (deps.mcpLauncher) return deps.mcpLauncher;
    const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
    if (root !== undefined) {
      try {
        return { bin: process.execPath, args: [realpathSync(join(root, 'dist', 'cli.js')), 'mcp'] };
      } catch {}
    }
    return commandParts(command, ['mcp']);
  };

  const agentContext = (project: boolean, command: string): AgentContext => ({ home: homeDir, cwd, project, command, mcp: resolveLauncher(command), exec, which, env, platform });

  let agentInFlight: AgentModule['id'] = 'codex';

  const applyStep = async (step: Step, options: AgentsOptions): Promise<boolean> => {
    if (step.kind === 'info') {
      stdout(step.text);
      return true;
    }
    if (step.kind === 'manual') {
      stdout(`Manual step: ${step.title}`);
      stdout(`File: ${step.path}`);
      for (const line of step.lines) stdout(`  ${line}`);
      return true;
    }
    if (step.kind === 'exec') {
      stdout(`Command: ${step.display}`);
      if (options.dryRun === true) return true;
      const confirmed = await confirmApply(options);
      if (confirmed === null) return false;
      if (!confirmed) return true;
      const manualRun = (reason: string): boolean => {
        stdout(`Manual step: ${reason}; run this yourself:`);
        stdout(`  ${step.display}`);
        return true;
      };
      const resolvedBin = which(step.bin);
      if (platform === 'win32' && resolvedBin !== null && /\.(cmd|bat)$/i.test(resolvedBin)) {
        return manualRun(`${step.bin} is a Windows shim that cannot be started without a shell`);
      }
      const result = exec(step.bin, step.args, cwd);
      if (result.error !== undefined && /ENOENT|EINVAL/.test(result.error)) {
        return manualRun(`${step.bin} could not be started (${result.error})`);
      }
      if (result.error !== undefined || result.status !== 0) {
        const reason = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.status)}`);
        stderr(`${step.display} failed: ${reason}`);
        const hint = failureHint(agentInFlight, reason);
        if (hint !== null) stderr(hint);
        stepFailed = true;
        return false;
      }
      stdout(`Ran: ${step.display}`);
      return true;
    }
    const resolved = resolveTargetPath(step.path, options.project === true);
    if (resolved === null) return false;
    const label = resolved !== step.path ? `${step.path} -> ${resolved}` : step.path;
    return applyChange(step.path, label, step.before, step.next, options, step.note);
  };

  const runAgentsAction = async (action: 'install' | 'uninstall', options: AgentsOptions): Promise<void> => {
    const project = options.project === true;
    const command = hookCommand({ which, version: readVersion(), npmCommand: env.npm_command });
    const ctx = agentContext(project, command);
    const chosen = AGENTS.filter((agent) => (options as Record<string, unknown>)[agentOptionKey(agent.id)] === true || (options.all === true && agent.detect(ctx)));
    if (chosen.length === 0) {
      if (options.all === true) {
        stdout('No supported agents detected.');
        return;
      }
      stderr(`Choose an agent: ${AGENTS.map((agent) => `--${agent.id}`).join(' ')} or --all.`);
      exit(2);
      return;
    }
    if (action === 'install') {
      stdout(`Command: ${command}`);
      if (command !== 'distill-llm') {
        if (options.dryRun !== true) {
          stderr('distill-llm is not installed globally, and a temporary npx path would break the registered server. Run: npm i -g distill-llm');
          exit(1);
          return;
        }
        stdout('Warning: distill-llm is not installed globally (npm i -g distill-llm); a real install would be refused.');
      }
    }
    if (action === 'install') {
      stdout('Note: the MCP server is registered with absolute paths; re-run `distill-llm agents install` after upgrading Node or moving the install.');
    }
    collectFailures = true;
    const failed: string[] = [];
    for (const agent of chosen) {
      stdout(`== ${agent.label} ==`);
      agentInFlight = agent.id;
      stepFailed = false;
      let steps: Step[];
      try {
        steps = await (action === 'install' ? agent.installSteps(ctx) : agent.uninstallSteps(ctx));
      } catch (error) {
        stderr(`${agent.label}: ${errorMessage(error)}`);
        failed.push(agent.label);
        continue;
      }
      if (steps.length === 0) stdout('Nothing to remove.');
      for (const step of steps) {
        const ok = await applyStep(step, options);
        if (!ok) {
          if (!stepFailed) {
            collectFailures = false;
            return;
          }
          failed.push(agent.label);
          break;
        }
      }
    }
    const skills: { path: string; label: string }[] = [];
    if (chosen.some((agent) => agent.skill === 'agents')) {
      const sharedBase = project ? cwd : homeDir;
      const stillUsing = action === 'uninstall' ? AGENTS.filter((agent: AgentModule) => agent.skill === 'agents' && !chosen.includes(agent) && agent.mcp(ctx) === 'yes') : [];
      if (stillUsing.length > 0) stdout(`Keeping the shared skill: still used by ${stillUsing.map((agent) => agent.label).join(', ')}.`);
      else skills.push({ path: agentsSkillPath(sharedBase), label: 'shared skill (~/.agents/skills)' });
    }
    if (!project && chosen.some((agent) => agent.skill === 'hermes')) skills.push({ path: hermesSkillPath(homeDir), label: 'Hermes skill' });
    for (const skill of skills) {
      stdout(`== ${skill.label} ==`);
      stepFailed = false;
      if (!(await processSkillAt(skill.path, agentsSkillMarkdown(command), action, options))) {
        if (!stepFailed) {
          collectFailures = false;
          return;
        }
        failed.push(skill.label);
      }
    }
    collectFailures = false;
    if (failed.length > 0) {
      stderr(`Failed: ${failed.join(', ')}. The other agents were processed.`);
      exit(1);
    }
  };

  for (const action of ['install', 'uninstall'] as const) {
    const sub = agents
      .command(action)
      .description(action === 'install' ? 'Register distill (MCP server and skill) with coding agents' : 'Remove distill from coding agents');
    sub
      .option('--codex', 'Codex CLI and the ChatGPT desktop app')
      .option('--gemini', 'Gemini CLI')
      .option('--cursor', 'Cursor')
      .option('--opencode', 'OpenCode (MCP server, plugin and skill)')
      .option('--claude-desktop', 'Claude Desktop')
      .option('--hermes', 'Hermes Agent')
      .option('--openclaw', 'OpenClaw')
      .option('--all', 'every detected agent')
      .option('--project', 'use project files instead of your home directory (where the agent supports it)')
      .option('--yes', 'apply without asking')
      .option('--dry-run', 'show what would change without changing anything')
      .action((options: AgentsOptions) => runAgentsAction(action, options));
  }

  agents
    .command('status')
    .description('Show where distill is installed')
    .option('--project', 'look at project files instead of your home directory')
    .action((options: HooksOptions) => {
      for (const line of renderStatus(statusRows(agentContext(options.project === true, 'distill-llm')))) stdout(line);
    });

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
