import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { isLoopbackHost } from '../core/loopback';
import { openDistiller as defaultOpenDistiller } from '../node/distill';
import type { Distiller } from '../node/distill';
import { serveMcpHttp as defaultServeMcpHttp } from '../mcp/http';
import { rootResolver, cwdResolver } from '../mcp/roots';
import { createMcpServer } from '../mcp/server';
import { connectStdio as defaultConnectStdio } from '../mcp/stdio';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startServer as defaultStartServer } from '../server/start';
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
}

const BYTES_PER_MB = 1024 * 1024;

function readVersion(): string {
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
  const startServer = deps.startServer ?? defaultStartServer;
  const openUrl = deps.openUrl ?? openInBrowser;
  const openDistiller = deps.openDistiller ?? defaultOpenDistiller;
  const connectStdio = deps.connectStdio ?? defaultConnectStdio;
  const serveMcpHttp = deps.serveMcpHttp ?? defaultServeMcpHttp;
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const handleSignals = deps.handleSignals ?? true;
  const env = deps.env ?? process.env;

  const program = new Command();
  program
    .name('distillmd')
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
      const cwd = process.cwd();
      let distiller: Distiller;
      try {
        distiller = await openDistiller();
      } catch (error) {
        stderr(`Failed to start distill: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
        return;
      }
      const build = (resolvePath: (path: string) => Promise<string>) => () =>
        createMcpServer({ distiller, health: () => distiller.health(), resolvePath });

      if (!options.http) {
        await connectStdio(build(cwdResolver(cwd))(), () => {
          distiller.close();
          exit(0);
        });
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

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      exit(error.exitCode === 0 ? 0 : 2);
      return;
    }
    throw error;
  }
}
