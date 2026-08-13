import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited, kubectl } from './helpers';

// Traffic and Cost - the two domains that have nothing to show in this cluster,
// and what they owe the user because of it.
//
// Neither can produce data here, and that is not a defect:
//   Traffic needs an eBPF collector (Caretta) that is not installed.
//   Cost needs Prometheus, which is not installed either.
//
// So there is no honest way to assert "the flows are correct" or "the costs are
// right". What CAN be asserted - and matters more for a product someone is
// evaluating - is that each page says why it is empty, says something TRUE
// about this cluster while doing it, and offers the way forward. The failure
// worth catching is a page that renders a blank panel, or worse, a confident
// zero, when the truth is "I cannot see this".
//
// Read off the running product before being written:
//  - Traffic prints "Cluster Detection | Platform: kind | CNI: unknown" and
//    recommends Caretta, describing it as eBPF-based and CNI-independent.
//  - Cost has Overview and Rightsizing tabs, says "Looking for Prometheus cost
//    data…", explains the port-forward discovery, and offers "Check again".

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

/** The platform this cluster really is, so the page's claim can be checked. */
function realPlatform(): string {
  const node = kubectl('get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}');
  return /kind|control-plane/.test(node) ? 'kind' : node;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('the Traffic page explains why it has no flows, and identifies this cluster correctly', async ({
  page,
}, testInfo) => {
  await gotoWhenNotRateLimited(page, '/traffic');

  await expect
    .poll(async () => (await bodyText(page)).length, {
      message: 'the Traffic page rendered nothing at all - a user cannot tell whether their cluster has no traffic or the page is broken',
      timeout: 60_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(300);

  const text = await bodyText(page);

  // It must not pretend. Either it shows flows, or it says it cannot see them.
  const explains = /no (traffic|flows|data)|not (installed|detected|available)|install|recommended|requires/i.test(text);
  expect
    .soft(
      explains,
      'the Traffic page shows no flows and does not explain why - an empty diagram with no explanation reads as "your services talk to nobody"',
    )
    .toBe(true);

  // And what it says about the cluster has to be true. This one is checkable:
  // the harness runs on kind, and the page claims to have detected the platform.
  if (/Platform:/i.test(text)) {
    expect
      .soft(
        text,
        `the Traffic page reports a platform that is not what this cluster runs on (kubectl says ${realPlatform()})`,
      )
      .toMatch(new RegExp(`Platform:\\s*${realPlatform()}`, 'i'));
  }

  // The way forward has to be actionable, not just a diagnosis.
  expect
    .soft(
      /caretta|ebpf|helm|install|documentation/i.test(text),
      'the Traffic page says it cannot see flows but offers no way to enable them',
    )
    .toBe(true);

  await expect
    .soft(
      page.getByText(/something went wrong|failed to load|unexpected error/i).first(),
      'the Traffic page rendered an error state',
    )
    .toBeHidden({ timeout: 10_000 });

  await captureSurface(page, testInfo, 'traffic-no-collector');
});

test('the Cost page says it is missing Prometheus rather than reporting zero cost', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/cost');

  await expect
    .poll(async () => (await bodyText(page)).length, {
      message: 'the Cost page rendered nothing at all',
      timeout: 60_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(300);

  const text = await bodyText(page);

  // The important one: without a metrics source, this page must say so. A cost
  // page that quietly renders 0 is worse than one that renders nothing - an
  // operator would conclude their cluster is free.
  expect
    .soft(
      /prometheus|no (cost|metrics) data|not (found|detected|available)|looking for/i.test(text),
      'the Cost page shows no cost data and never mentions what it is missing - a user is left to conclude the cluster costs nothing',
    )
    .toBe(true);

  expect
    .soft(
      /\$\s*0(\.00)?\b/.test(text) && !/prometheus|looking for|no .*data/i.test(text),
      'the Cost page reports a cost of zero without saying it has no data source',
    )
    .toBe(false);

  await captureSurface(page, testInfo, 'cost-no-metrics-source');

  // Both tabs must be reachable. Rightsizing is the half of this domain that
  // reads request configuration rather than metrics, so it is the part that
  // could work here.
  // These are <a role="tab"> with aria-selected, not buttons - getByRole
  // ('button') never matches them, which reads as the views not existing.
  for (const tab of ['Overview', 'Rightsizing']) {
    const control = page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') }).first();
    const present = await expect(control)
      .toBeVisible({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect.soft(present, `the Cost page offers no "${tab}" view`).toBe(true);
    if (!present) continue;

    await control.click();

    // The tab strip must say which view is showing. Selecting a tab that never
    // reports itself selected leaves a user unable to tell where they are.
    await expect
      .poll(async () => control.getAttribute('aria-selected'), {
        message: `selecting the Cost "${tab}" view never marked it as the selected tab`,
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .toBe('true');

    await expect
      .soft(
        page.getByText(/something went wrong|failed to load|unexpected error/i).first(),
        `the Cost page "${tab}" view rendered an error`,
      )
      .toBeHidden({ timeout: 10_000 });

    await captureSurface(page, testInfo, `cost-${tab.toLowerCase()}`);
  }
});
