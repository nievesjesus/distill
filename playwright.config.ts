import { defineConfig, devices } from '@playwright/test';

const origin = 'http://127.0.0.1:4399';

export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'desktop.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: origin },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node dist/cli.js --port 4399 --no-open',
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
