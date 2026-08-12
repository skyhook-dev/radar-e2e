import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  clusterId,
  watchConsoleErrors,
} from './helpers';

// Every tab a workload detail view offers, opened and checked.
//
// The rest of the suite drives one or two surfaces per scenario and moves on,
// which leaves most of a page's tabs never opened at all: a tab that throws,
// renders blank, or shows a loading spinner forever would not fail anything.
// Standing up a cluster costs minutes, so once it is up the cheap thing to do
// is walk the whole surface rather than a corner of it.
//
// Assertions here are deliberately `expect.soft`. A hard assertion stops the
// test at the first broken tab, which is the worst possible outcome for a
// sweep: you fix that one, re-run, and discover the next. Soft assertions
// report every broken tab in one pass, and the test still fails at the end.
//
// What is asserted per tab, and why it is worth asserting:
//   - the tab actually becomes selected (aria-selected), so a click that does
//     nothing is caught rather than read as success
//   - the panel renders something, so a blank tab is caught
//   - the panel is not showing an error or a stuck loading state
// Copy-specific assertions are kept to the ones verified against the real UI;
// inventing expected wording for eight tabs would produce a test that fails on
// harmless rewording and proves little.

const NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';

// From the fixture: a healthy Deployment with config, a secret and a Service,
// and a workload that logs continuously so the Logs tab has a live source.
const HEALTHY = 'storefront';
const CHATTY = 'chatty';

/** Tabs the workload view always offers, whatever is installed in the cluster. */
const ALWAYS_PRESENT = ['Overview', 'Timeline', 'YAML'] as const;

test.use({ storageState: authStatePath });
test.setTimeout(180_000);

/** Text that means the panel failed rather than rendered. */
const BROKEN = /something went wrong|failed to load|unable to load|unexpected error/i;

async function openWorkload(page: Page, name: string) {
  await page.goto(`/c/${clusterId}/workload/deployments/${NS}/${name}`);
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: 30_000 });
}

/** Open one tab and report everything wrong with it, without stopping. */
async function checkTab(page: Page, label: string, testInfo: Parameters<typeof captureSurface>[1]): Promise<string> {
  const tab = page.getByRole('tab', { name: new RegExp(`^\\s*${label}`, 'i') });
  await tab.click();

  await expect
    .soft(tab, `the ${label} tab did not become selected after being clicked`)
    .toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  // DetailShell renders the panel as a plain div - there is no role="tabpanel"
  // and no aria-controls, so there is nothing to target directly. Asserting on
  // the rendered text is cruder but catches what matters: a tab that selects
  // and then shows nothing.
  await expect
    .soft(async () => (await page.locator('body').innerText()).trim().length, `the ${label} tab selected but rendered almost nothing`)
    .toPass({ timeout: 15_000 });
  const rendered = (await page.locator('body').innerText()).trim();
  expect
    .soft(rendered.length, `the ${label} tab selected but rendered almost no text (${rendered.length} chars)`)
    .toBeGreaterThan(200);

  await expect
    .soft(page.getByText(BROKEN).first(), `the ${label} tab rendered an error state`)
    .toBeHidden({ timeout: 10_000 });

  // A tab still spinning after this long is not loading, it is stuck - and it
  // looks identical to a working tab in a screenshot.
  await expect
    .soft(page.getByText(/^\s*(loading|fetching)/i).first(), `the ${label} tab was still showing a loading state after 10s`)
    .toBeHidden({ timeout: 10_000 });

  await captureSurface(page, testInfo, `workload-tab-${label.toLowerCase()}`);
  return rendered;
}

test('every tab the workload view offers opens and renders', async ({ page }, testInfo) => {
  const consoleErrors = watchConsoleErrors(page);
  await page.goto('/');
  await assertClusterConnected(page);
  await openWorkload(page, HEALTHY);

  // Read the tabs the product actually offers rather than assuming a list:
  // if a tab is added, this picks it up and checks it without an edit here.
  const offered = (await page.getByRole('tab').allTextContents())
    .map((t) => t.trim())
    .filter(Boolean);
  expect(offered.length, 'the workload view offered no tabs at all').toBeGreaterThan(0);
  testInfo.annotations.push({ type: 'tabs offered', description: offered.join(', ') });

  for (const label of ALWAYS_PRESENT) {
    expect
      .soft(
        offered.some((t) => t.toLowerCase().startsWith(label.toLowerCase())),
        `the workload view did not offer a ${label} tab - it is not conditional on anything installed in the cluster`,
      )
      .toBe(true);
  }

  const renderedByTab = new Map<string, string>();
  for (const label of offered) {
    // Every offered tab gets opened, including ones added since this was
    // written. The name is normalised because a tab may carry a count badge.
    const name = label.split(/\s{2,}|\n/)[0];
    renderedByTab.set(name, await checkTab(page, name, testInfo));
  }

  // Selecting a tab must change what is on screen. This is the check that does
  // not depend on knowing any tab's copy: if two tabs render byte-identical
  // text, one of them is a label that does nothing, which looks completely
  // healthy in a screenshot and in an aria-selected assertion.
  const seen = new Map<string, string>();
  for (const [name, text] of renderedByTab) {
    const twin = seen.get(text);
    expect
      .soft(twin, `the ${name} tab renders exactly the same content as the ${twin} tab - selecting it changes nothing`)
      .toBeUndefined();
    seen.set(text, name);
    testInfo.annotations.push({ type: `tab:${name}`, description: `${text.length} chars rendered` });
  }

  // The gallery surfaces these per scenario, so a tab that renders but throws
  // in the console still gets reported rather than passing silently.
  const errors = consoleErrors();
  if (errors.length) {
    await testInfo.attach('workload-tabs-console-errors.json', {
      body: JSON.stringify(errors, null, 2),
      contentType: 'application/json',
    });
  }
});

test('a workload with live output offers Logs, and the tab streams them', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await openWorkload(page, CHATTY);

  const logsTab = page.getByRole('tab', { name: /^\s*Logs/i });
  await expect(
    logsTab,
    'the Logs tab is missing for a workload that is producing output - the tab is conditional on log availability, so this means the hub could not see any',
  ).toBeVisible({ timeout: 30_000 });

  await logsTab.click();
  // The fixture prints a numbered line every 2s, so the stream must produce
  // one of them rather than merely rendering an empty log pane.
  await expect(
    page.getByText(/fixture log line \d+/).first(),
    'the Logs tab never showed a line from a workload that logs every 2 seconds',
  ).toBeVisible({ timeout: 60_000 });

  await captureSurface(page, testInfo, 'workload-tab-logs-streaming');
});

test('tabs whose data source is missing say so, and stop waiting', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await openWorkload(page, HEALTHY);

  // Neither Prometheus nor OpenCost is installed on this cluster.
  //
  // This started out asserting that the tabs are HIDDEN, which was wrong: the
  // Metrics tab is offered and explains itself - "Prometheus not connected",
  // with a Discover button. That is better than hiding it, because a user who
  // cannot see the tab cannot learn the capability exists. The real invariant
  // is that a tab with no data source SAYS so and stops, rather than showing a
  // spinner that never resolves or an empty chart that reads as real zeroes.
  await page.getByRole('tab', { name: /^\s*Metrics/i }).click();
  await expect(
    page.getByText(/prometheus not connected/i),
    'the Metrics tab did not explain that Prometheus is missing - an empty chart here reads as "no traffic" rather than "no data source"',
  ).toBeVisible({ timeout: 20_000 });
  await captureSurface(page, testInfo, 'metrics-tab-no-prometheus');

  await page.getByRole('tab', { name: /^\s*Cost/i }).click();

  // The Cost tab opens on "Looking for Prometheus cost data... First discovery
  // can take a few seconds". Prometheus is not installed and never will be, so
  // discovery must end in an answer. A spinner still turning long after the
  // "few seconds" it promises is indistinguishable from a hung request.
  const stillSearching = page.getByText(/looking for prometheus cost data/i);
  await expect(
    stillSearching,
    'the Cost tab never even started discovery - expected it to look for Prometheus first',
  ).toBeVisible({ timeout: 20_000 });

  await expect
    .soft(
      stillSearching,
      'the Cost tab was still showing "Looking for Prometheus cost data..." 90s after opening, on a cluster with no Prometheus. It promises "a few seconds"; a spinner that never resolves cannot be told apart from a hung request, and the Metrics tab answers the same question immediately',
    )
    .toBeHidden({ timeout: 90_000 });

  await captureSurface(page, testInfo, 'cost-tab-no-prometheus');
});
