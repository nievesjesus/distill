import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export default defineConfig({
  entry: { main: 'desktop/main.ts' },
  outDir: 'dist/desktop',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: false,
  sourcemap: false,
  dts: false,
  external: ['electron', ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
});
