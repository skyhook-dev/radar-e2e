import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  clusterId,
  kubectl,
  walkTabs,
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
  // expect.poll, not expect.soft(fn).toPass(): toPass retries until the
  // callback stops THROWING, and one that returns a number never throws, so it
  // passes on the first call and asserts nothing.
  await expect
    .poll(async () => (await page.locator('body').innerText()).trim().length, {
      message: `the ${label} tab selected but rendered almost nothing`,
      timeout: 15_000,
      intervals: [500, 1000, 2000],
    })
    .toBeGreaterThan(200);
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

// Each fixture kind renders a DIFFERENT tab set - Reachability only appears for
// kinds the product can diagnose, Logs only where there is output to stream - so
// walking a Deployment proves nothing about the others. These are the kinds the
// shared fixture provides.
const KINDS: { path: string; name: string; what: string }[] = [
  { path: 'deployments', name: HEALTHY, what: 'a healthy Deployment' },
  { path: 'deployments', name: 'broken-image', what: 'a Deployment stuck in ImagePullBackOff' },
  { path: 'deployments', name: 'unschedulable', what: 'a Deployment whose pod cannot be scheduled' },
  { path: 'statefulsets', name: 'ledger', what: 'a StatefulSet with a volume claim' },
  { path: 'daemonsets', name: 'node-probe', what: 'a DaemonSet' },
  { path: 'jobs', name: 'migrate-once', what: 'a completed Job' },
  { path: 'cronjobs', name: 'nightly-report', what: 'a CronJob that has not run yet' },
  { path: 'services', name: HEALTHY, what: 'a Service with endpoints' },
  { path: 'services', name: 'orphaned', what: 'a Service whose selector matches nothing' },
];

/**
 * One defining fact per kind, read from the cluster at run time.
 *
 * Walking the tabs proves they open; it does not prove the view is about this
 * workload. These are the facts that would be wrong if it were showing another
 * object, or a cached one - and they are read from the cluster rather than
 * written down here, so they track the fixture instead of a copy of it.
 */
function truthFor(kindPath: string, name: string): { what: string; value: string }[] {
  const singular = kindPath.replace(/s$/, '');
  const object = JSON.parse(kubectl('get', singular, name, '-n', NS, '-o', 'json'));
  switch (kindPath) {
    case 'services': {
      const ports = (object.spec.ports ?? []).map((p: { port: number }) => String(p.port));
      return [
        { what: 'its service type', value: object.spec.type },
        ...ports.slice(0, 1).map((port: string) => ({ what: `the port it serves (${port})`, value: port })),
      ];
    }
    case 'cronjobs':
      return [{ what: 'its schedule', value: object.spec.schedule }];
    case 'jobs':
      return [{ what: 'the image it ran', value: object.spec.template.spec.containers[0].image }];
    default:
      return [{ what: 'the image it runs', value: object.spec.template.spec.containers[0].image }];
  }
}

for (const kind of KINDS) {
  test(`every tab opens and renders for ${kind.what}`, async ({ page }, testInfo) => {
    const consoleErrors = watchConsoleErrors(page);
    await page.goto('/');
    await assertClusterConnected(page);

    await page.goto(`/c/${clusterId}/workload/${kind.path}/${NS}/${kind.name}`);

    // A kind whose detail view does not open at all is worth failing loudly
    // for - the tab walk below could otherwise report "no tabs" and read like
    // a missing feature rather than a broken route.
    await expect(
      page.getByRole('heading', { name: new RegExp(kind.name, 'i') }).first(),
      `the detail view for ${kind.what} (${kind.path}/${kind.name}) never rendered its heading`,
    ).toBeVisible({ timeout: 30_000 });

    // Before walking the tabs: is this view actually about this workload? A
    // detail that opens, renders and offers every tab is still wrong if it is
    // describing something else.
    for (const fact of truthFor(kind.path, kind.name)) {
      if (!fact.value) continue;
      // Polled: the heading renders before the panel behind it does, so
      // reading the body once here reports facts as missing that arrive a
      // second later - it did exactly that for the StatefulSet and the Job.
      const shown = await expect
        .poll(async () => (await page.locator('body').innerText()).includes(fact.value), {
          timeout: 45_000,
          intervals: [1000, 2000, 3000, 5000],
        })
        .toBe(true)
        .then(() => true)
        .catch(() => false);
      expect
        .soft(
          shown,
          `the view for ${kind.what} does not show ${fact.what} (${fact.value}) - the tabs are there but the ` +
            `content is not this workload's`,
        )
        .toBe(true);
    }

    const { offered } = await walkTabs(page, testInfo, `${kind.path}-${kind.name}`);

    // Overview and YAML are not conditional on anything installed, so their
    // absence is a real gap rather than an unavailable data source.
    for (const required of ['Overview', 'YAML']) {
      expect
        .soft(
          offered.some((t) => t.toLowerCase() === required.toLowerCase()),
          `${kind.what} offered no ${required} tab - it is unconditional, so this is missing rather than unavailable`,
        )
        .toBe(true);
    }

    const errors = consoleErrors();
    if (errors.length) {
      await testInfo.attach(`${kind.path}-${kind.name}-console-errors.json`, {
        body: JSON.stringify(errors, null, 2),
        contentType: 'application/json',
      });
    }
  });
}

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
