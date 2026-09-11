import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    {
      name: 'ui',
      testMatch: /ui\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Real relays, real peers. Slow and networked, so it never runs in CI.
      name: 'live',
      testMatch: /live\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      retries: 0,
      timeout: 120_000,
    },
  ],
  webServer: {
    command: `npm run build && node tools/serve.mjs play ${PORT}`,
    url: `${baseURL}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
