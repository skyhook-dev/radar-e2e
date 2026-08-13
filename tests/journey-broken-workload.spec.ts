import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  clusterId,
  gotoWhenNotRateLimited,
  kubectl,
} from './helpers';

// A real scenario, followed all the way through the product.
//
// Everything else in this suite checks one surface at a time. This checks the
// thing an operator actually experiences: something breaks in their cluster,
// and they find out about it, look into it, triage it, fix it, and expect the
// product to agree with them at every step.
//
//   1. A deployment is created with an image that does not exist.
//   2. It has to be DETECTED - present in the fleet issues API, attributed to
//      the right cluster, namespace and kind.
//   3. It has to be FINDABLE everywhere the operator might look: the dashboard
//      they land on, the Issues queue, the Applications list, the Resources
//      table (as a pod in ImagePullBackOff), and the Timeline.
//   4. It has to be TRIAGEABLE: marking it seen leaves a trace others can see.
//   5. It has to CLEAR when the underlying problem is fixed - from the API, the
//      Issues queue and the dashboard alike.
//
// Step 5 is the one that isolated tests never cover and that matters most. A
// product that raises an issue and never withdraws it trains its users to
// ignore it.
//
// Written to keep going: each surface is a soft assertion, so a run reports
// EVERY place the workload failed to show up rather than the first. The two
// facts the journey cannot continue without - it was created, and it was
// detected - are hard.

test.use({ storageState: authStatePath });
test.setTimeout(600_000);
test.describe.configure({ mode: 'serial' });

const NAMESPACE = process.env.FIXTURE_NS ?? 'e2e-fixtures';
const WORKLOAD = `journey-broken-${Date.now()}`;
const BAD_IMAGE = 'registry.k8s.io/pause:this-tag-does-not-exist';
const GOOD_IMAGE = 'registry.k8s.io/pause:3.9';

type FleetIssue = { cluster_id: string; namespace: string; name: string; kind: string; severity: string; reason?: string };

/** The fleet issues the hub is currently reporting, read through the app. */
async function fleetIssues(page: Page): Promise<FleetIssue[]> {
  return page
    .evaluate(async () => {
      const res = await fetch('/api/fleet/issues');
      if (!res.ok) return [];
      return (await res.json()).issues ?? [];
    })
    .catch(() => []);
}

const ours = (issues: FleetIssue[]) =>
  issues.find((i) => i.namespace === NAMESPACE && i.name === WORKLOAD && i.kind === 'Deployment');

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

test.beforeAll(() => {
  kubectl('create', 'deployment', WORKLOAD, `--image=${BAD_IMAGE}`, '-n', NAMESPACE);
});

test.afterAll(() => {
  kubectl('delete', 'deployment', WORKLOAD, '-n', NAMESPACE, '--ignore-not-found');
});

test('a workload that breaks is detected and can be found everywhere the operator looks', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // Detection first: without this, every surface check below would be
  // reporting the same single fact and none of them would mean anything.
  await expect
    .poll(async () => Boolean(ours(await fleetIssues(page))), {
      message:
        `${NAMESPACE}/${WORKLOAD} was created with an image that cannot be pulled, but no issue for it ever ` +
        `reached /api/fleet/issues - either radar did not detect it or the fan-out to the hub is broken`,
      timeout: 180_000,
      intervals: [3000, 3000, 5000, 5000, 10_000],
    })
    .toBe(true);

  const issue = ours(await fleetIssues(page)) as FleetIssue;
  expect
    .soft(issue.cluster_id, 'the issue is not attributed to the cluster it came from')
    .toBe(clusterId);
  expect
    .soft((issue.reason ?? '').toLowerCase(), 'the issue does not say what is actually wrong with the pod')
    .toMatch(/image|pull/);

  // Now the surfaces. Each is soft: the point of this test is to report every
  // place it is missing from, not to stop at the first.
  const surfaces: { path: string; label: string; why: string }[] = [
    { path: '/', label: 'dashboard', why: 'the page an operator lands on does not mention the workload that just broke' },
    { path: '/issues', label: 'issues', why: 'the triage queue does not list the broken workload' },
    { path: '/applications', label: 'applications', why: 'the workload is not listed as an application' },
    { path: '/resources', label: 'resources', why: 'the pod stuck pulling its image is not in the resource table' },
  ];

  for (const { path, label, why } of surfaces) {
    await gotoWhenNotRateLimited(page, path);

    // Resources defaults to Pods and paginates, so the workload is searched
    // for by name rather than expected to be on screen already.
    if (path === '/resources') {
      const search = page.getByPlaceholder('Search... (press /)').first();
      if (await search.count()) {
        await search.fill(WORKLOAD);
        await page.waitForTimeout(3000);
      }
    }

    const found = await expect
      .poll(async () => (await bodyText(page)).includes(WORKLOAD), { timeout: 45_000, intervals: [2000, 3000, 5000] })
      .toBe(true)
      .then(() => true)
      .catch(() => false);

    expect.soft(found, `${path}: ${why}`).toBe(true);
    await captureSurface(page, testInfo, `journey-broken-on-${label}`);
  }
});

test('the broken workload can be triaged, and the triage is visible to everyone', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/issues');

  // Find the row for OUR workload rather than whatever is at the top - the
  // fixture cluster is deliberately full of other broken things.
  const row = page
    .locator('[role=button]')
    .filter({ has: page.locator('button[aria-label^="Dismiss" i]') })
    .filter({ hasText: WORKLOAD })
    .first();

  const present = await expect(row)
    .toBeVisible({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  expect.soft(present, `the Issues queue has no row for ${WORKLOAD} to triage`).toBe(true);
  test.skip(!present, 'nothing to triage');

  await row.locator('button[aria-label^="Mark seen" i]').first().click();

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const res = await fetch('/api/triage');
          if (!res.ok) return [];
          return ((await res.json()).records ?? []).map((r: { verb: string }) => r.verb);
        }),
      {
        message: 'marking the broken workload as seen stored nothing on the hub, so no colleague would see it',
        timeout: 45_000,
        intervals: [2000, 3000],
      },
    )
    .toContain('ack');

  await captureSurface(page, testInfo, 'journey-broken-triaged');

  // Put it back, so the next test sees the issue in its original state.
  const records = await page.evaluate(async () => ((await (await fetch('/api/triage')).json()).records ?? []));
  for (const rec of records as { id: string }[]) {
    await page.evaluate(async (id) => fetch(`/api/triage/${id}`, { method: 'DELETE' }), rec.id);
  }
});

test('fixing the workload clears the issue from the API, the queue and the dashboard', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // The fix an operator would actually apply: point it at an image that exists.
  //
  // Targets every container with `*=`, not `<workload>=`. `kubectl create
  // deployment X --image=registry.k8s.io/pause:tag` names the container after
  // the IMAGE - "pause" - not after the deployment, so naming the container
  // after the workload fails with "unable to find container named ...".
  kubectl('set', 'image', `deployment/${WORKLOAD}`, `*=${GOOD_IMAGE}`, '-n', NAMESPACE);

  // The pod has to actually come up first - otherwise this is asserting on the
  // product while the cluster is still mid-rollout, and a failure here would
  // be blaming the page for kubelet's timing.
  await expect
    .poll(
      () =>
        kubectl('get', 'deployment', WORKLOAD, '-n', NAMESPACE, '-o', 'jsonpath={.status.readyReplicas}') || '0',
      {
        message: `${NAMESPACE}/${WORKLOAD} never became ready after being pointed at ${GOOD_IMAGE} - a cluster problem, not a product one`,
        timeout: 240_000,
        intervals: [5000, 5000, 10_000],
      },
    )
    .toBe('1');

  // Now the product must withdraw what it raised.
  await expect
    .poll(async () => Boolean(ours(await fleetIssues(page))), {
      message:
        `${NAMESPACE}/${WORKLOAD} is running and healthy, but the hub still reports an issue for it - ` +
        `an alert that never clears is one users learn to ignore`,
      timeout: 240_000,
      intervals: [5000, 5000, 10_000],
    })
    .toBe(false);

  await gotoWhenNotRateLimited(page, '/issues');
  await expect
    .poll(async () => (await bodyText(page)).includes(WORKLOAD), {
      message: `${WORKLOAD} was fixed and is gone from the API, but the Issues queue still lists it`,
      timeout: 90_000,
      intervals: [3000, 5000],
    })
    .toBe(false);

  await gotoWhenNotRateLimited(page, '/');
  await expect
    .poll(async () => (await bodyText(page)).includes(WORKLOAD), {
      message: `${WORKLOAD} was fixed, but the dashboard still shows it as an active issue`,
      timeout: 90_000,
      intervals: [3000, 5000],
    })
    .toBe(false);

  await captureSurface(page, testInfo, 'journey-broken-resolved');
});
