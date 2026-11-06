import { chmodSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  clean: false,
  sourcemap: false,
  dts: false,
  external: ['@llamaindex/liteparse', '@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'],
  onSuccess: async () => {
    chmodSync('dist/cli.js', 0o755);
  },
});
