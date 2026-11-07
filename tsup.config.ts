import { chmodSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  splitting: true,
  clean: ['!web/**', '!desktop/**'],
  sourcemap: false,
  dts: false,
  external: ['@llamaindex/liteparse'],
  onSuccess: async () => {
    chmodSync('dist/cli.js', 0o755);
  },
});
