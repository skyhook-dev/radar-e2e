import { defineConfig } from '@playwright/test';

// Standalone radar, reached directly (no port-forward, no auth session to
// warm up). Retries stay at 0: a flaky pass on the second attempt would hide
// exactly what this suite exists to catch.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.RADAR_URL ?? 'http://127.0.0.1:9280',
    trace: 'retain-on-failure',
    // A screenshot on every test, not just failures: the suite doubles as a
    // visual record of what the published CLI's UI looks like on this
    // release, so a passing run still leaves something worth looking at.
    screenshot: 'on',
    video: 'retain-on-failure',
  },
});
