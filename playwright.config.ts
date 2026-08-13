import { defineConfig } from '@playwright/test';

// The hub is reached through a port-forward the harness sets up (kind has no
// load balancer). Retries stay at 0: a scheduled run that quietly passes on
// the second attempt hides exactly the flakiness this suite exists to catch.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One retry in CI only. It does not paper over a broken product: a failing
  // assertion fails again on the retry. What it absorbs is the harness losing
  // its port-forward mid-run, which took out a whole domain's specs with
  // ERR_CONNECTION_RESET while the same specs passed on the other variant.
  // Playwright reports a test that needed the retry as flaky, and the gallery
  // shows that count, so nothing is hidden.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // The HTML report carries the attachments (matched events, timeline
  // screenshot), so CI produces it on success too - a scheduled run that only
  // reports on failure never shows anyone that the timeline actually rendered.
  // The JSON report is what lets the gallery label a recording with the test's
  // real title and outcome. Playwright's own output directory names are
  // truncated with a hash in the middle ("a-rule-matching-a-r-0bca7-ppears-as
  // -an-alert-instance"), which is not something to put in front of a reviewer.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: process.env.HUB_URL ?? 'http://localhost:18080',
    trace: 'retain-on-failure',
    // A wider window and 2x pixel density. The suite is read by people looking
    // at screenshots, and at 1x the product's small text - table cells, badges,
    // helper copy - is exactly where it is hardest to tell a rendering problem
    // from JPEG-ish mush. 1440 wide also stops the layout collapsing to its
    // narrow breakpoint, which was hiding columns a desktop user would see.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // Capture a screenshot at the end of EVERY test, not just failures: the
    // suite doubles as a visual record of what the product looked like on this
    // commit, and the gallery job pairs each shot with the same test from the
    // published release. Specs that attach their own mid-test screenshots
    // still do - both end up in the report.
    screenshot: 'on',
    // A recording of the whole session, kept only when a test fails.
    //
    // Recording everything was tried and dropped: the recordings nobody opens
    // are the ones for tests that passed, and they were spending the artifact
    // budget the screenshots need in order to be worth reading. On a failure
    // the recording is the most useful thing in the report, because it shows
    // how the test got where it got - which a screenshot of the end state
    // cannot.
    //
    // 854x480 is about Playwright's own default and is the smallest size where
    // the product's body text stays readable - checked against a real frame,
    // not guessed. Playwright records at a fixed 25fps with no way to change
    // it, so the frame rate comes down in the gallery job instead.
    video:
      process.env.E2E_VIDEO === 'off'
        ? 'off'
        : {
            mode: (process.env.E2E_VIDEO ?? 'retain-on-failure') as 'on' | 'retain-on-failure',
            size: { width: 854, height: 480 },
          },
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
