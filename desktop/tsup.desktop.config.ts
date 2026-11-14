import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const shared = {
  outDir: 'dist/desktop',
  platform: 'node',
  target: 'node22',
  clean: false,
  sourcemap: false,
  dts: false,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { main: 'desktop/main.ts' },
    format: ['esm'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    external: ['electron', ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
  },
  {
    ...shared,
    entry: { preload: 'desktop/preload.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    external: ['electron'],
  },
]);
