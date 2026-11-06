import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { startServer as defaultStartServer } from '../server/start';

type Server = { url: string; close(): Promise<void> };

export interface CliDeps {
  startServer?: (opts: { port: number; host: string; maxBytes: number }) => Promise<Server>;
  openUrl?: (url: string) => void;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  exit?: (code: number) => never;
  handleSignals?: boolean;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
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

export function openInBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '""', url] }
        : { file: 'xdg-open', args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

interface WebOptions {
  port: number;
  host: string;
  maxSize: number;
  open: boolean;
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<void> {
  const startServer = deps.startServer ?? defaultStartServer;
  const openUrl = deps.openUrl ?? openInBrowser;
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const handleSignals = deps.handleSignals ?? true;

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
    .action(async (options: WebOptions) => {
      let server: Server;
      try {
        server = await startServer({
          port: options.port,
          host: options.host,
          maxBytes: Math.round(options.maxSize * BYTES_PER_MB),
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
      if (!LOOPBACK_HOSTS.has(options.host.toLowerCase())) {
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
