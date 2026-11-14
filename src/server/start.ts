import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { isLoopbackHost } from '../core/loopback';
import type { InstallMethod } from '../core/types';
import { exposeLibreOffice } from '../node/capabilities';
import { createLingua, findPackageRoot } from '../node/lingua';
import { createLinguaInstaller } from '../node/lingua-install';
import { createParser } from '../node/parse';
import { createUpdateChecker, detectInstallMethod } from '../node/update-check';
import { createGlobalUpdater } from '../node/update-install';
import { createApp } from './app';
import { createStore } from './store';

const MAX_STORED_FILES = 50;
const MAX_STORED_BYTES = 200 * 1024 * 1024;

function readVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

export async function startServer(opts: {
  port: number;
  host: string;
  maxBytes: number;
  allowedHosts?: readonly string[];
  installMethod?: InstallMethod;
}): Promise<{ url: string; close(): Promise<void> }> {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot === undefined) throw new Error('distill-llm package.json not found');
  const require = createRequire(import.meta.url);
  const version = readVersion(join(packageRoot, 'package.json'));
  const liteparseVersion = readVersion(require.resolve('@llamaindex/liteparse/package.json'));
  const webRoot = join(packageRoot, 'dist', 'web');

  const libreoffice = await exposeLibreOffice();
  const parser = createParser();
  try {
    const cacheDir = join(homedir(), '.cache', 'distill-llm');
    const installer = createLinguaInstaller({ cacheDir, runtimeDir: join(packageRoot, 'lingua-runtime') });
    const lingua = createLingua({ cacheDir, installer });
    await lingua.probe();
    const method = opts.installMethod ?? detectInstallMethod({ packageRoot, env: process.env });
    const checker = createUpdateChecker({ current: version, method, cacheDir });
    const updater = method === 'npm-global' ? createGlobalUpdater({ packageRoot }) : null;
    const app = createApp({
      parser,
      lingua,
      store: createStore({ maxFiles: MAX_STORED_FILES, maxBytes: MAX_STORED_BYTES }),
      maxBytes: opts.maxBytes,
      libreoffice,
      version,
      liteparseVersion,
      webRoot: existsSync(webRoot) ? webRoot : undefined,
      guardLoopback: isLoopbackHost(opts.host),
      allowedHosts: opts.allowedHosts ?? [],
      updates: { checker, updater },
    });

    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const listening = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host, overrideGlobalObjects: false }, () => resolve(listening));
      listening.once('error', reject);
    });

    const { port } = server.address() as AddressInfo;
    const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
    return {
      url: `http://${host}:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            parser.close();
            if (error) reject(error);
            else resolve();
          });
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        }),
    };
  } catch (error) {
    parser.close();
    throw error;
  }
}
