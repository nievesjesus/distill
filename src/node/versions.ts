import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export function readPackageVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

export function readLiteparseVersion(): string {
  return readPackageVersion(createRequire(import.meta.url).resolve('@llamaindex/liteparse/package.json'));
}
