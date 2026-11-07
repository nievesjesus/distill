import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@core': fileURLToPath(new URL('./src/core', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'], exclude: ['tests/e2e-cli/**', '**/node_modules/**'] },
      },
      {
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/tests/**/*.test.{ts,tsx}'],
          setupFiles: ['web/tests/setup.ts'],
        },
      },
    ],
  },
});
