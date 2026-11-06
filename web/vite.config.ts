import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = 'http://127.0.0.1:4321';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: { '@core': fileURLToPath(new URL('../src/core', import.meta.url)) },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
