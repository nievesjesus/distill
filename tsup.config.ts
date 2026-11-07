import { chmodSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  splitting: true,
  clean: false,
  sourcemap: false,
  dts: false,
  external: ['@llamaindex/liteparse'],
  onSuccess: async () => {
    chmodSync('dist/cli.js', 0o755);
  },
});
