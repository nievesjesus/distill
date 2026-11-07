import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'smoke',
    environment: 'node',
    include: ['tests/e2e-cli/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
