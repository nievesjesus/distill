import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'desktop.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  timeout: 90_000,
});
