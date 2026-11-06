import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { hasLibreOffice } from '../node/capabilities';
import { createLingua } from '../node/lingua';
import { createParser } from '../node/parse';
import { createApp } from './app';
import { createStore } from './store';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_STORED_FILES = 50;
const MAX_STORED_BYTES = 200 * 1024 * 1024;

function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('distillmd package.json not found');
    dir = parent;
  }
  return dir;
}

function readVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

export async function startServer(opts: {
  port: number;
  host: string;
  maxBytes: number;
}): Promise<{ url: string; close(): Promise<void> }> {
  const packageRoot = findPackageRoot();
  const require = createRequire(import.meta.url);
  const version = readVersion(join(packageRoot, 'package.json'));
  const liteparseVersion = readVersion(require.resolve('@llamaindex/liteparse/package.json'));
  const webRoot = join(packageRoot, 'dist', 'web');

  const parser = createParser();
  try {
    const lingua = createLingua({ cacheDir: join(homedir(), '.cache', 'distillmd') });
    const [libreoffice] = await Promise.all([hasLibreOffice(), lingua.probe()]);
    const app = createApp({
      parser,
      lingua,
      store: createStore({ maxFiles: MAX_STORED_FILES, maxBytes: MAX_STORED_BYTES }),
      maxBytes: opts.maxBytes,
      libreoffice,
      version,
      liteparseVersion,
      webRoot: existsSync(webRoot) ? webRoot : undefined,
      guardLoopback: LOOPBACK_HOSTS.has(opts.host.toLowerCase()),
    });

    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const listening = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => resolve(listening));
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
