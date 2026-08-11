import { defineConfig } from '@playwright/test';

// The hub is reached through a port-forward the harness sets up (kind has no
// load balancer). Retries stay at 0: a scheduled run that quietly passes on
// the second attempt hides exactly the flakiness this suite exists to catch.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  // The HTML report carries the attachments (matched events, timeline
  // screenshot), so CI produces it on success too - a scheduled run that only
  // reports on failure never shows anyone that the timeline actually rendered.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.HUB_URL ?? 'http://localhost:18080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // One sign-in for the whole suite. The hub allows 5 break-glass logins per
  // minute per IP, so a per-test login would start returning 429 as soon as the
  // suite grew past a handful of specs.
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      use: { storageState: '.run/auth.json' },
      dependencies: ['setup'],
    },
  ],
});
