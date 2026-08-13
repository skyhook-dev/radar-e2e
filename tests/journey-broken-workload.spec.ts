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

/**
 * Unread notifications, as the API has them.
 *
 * This journey is the only place the inbox can honestly be checked. An alert
 * rule's first poll of a cluster is a BASELINE - whatever is already broken is
 * recorded without notifying - so on a fresh cluster the fixture issues never
 * raise anything. This workload is created after that baseline, so it should.
 */
async function unreadNotifications(page: Page): Promise<Array<{ id: number; kind: string }>> {
  return page
    .evaluate(async () => {
      const orgsRes = await fetch('/api/orgs');
      if (!orgsRes.ok) return [];
      const orgs = await orgsRes.json();
      const org = Array.isArray(orgs) ? orgs[0] : (orgs.orgs ?? [])[0];
      if (!org?.id) return [];
      const res = await fetch(`/api/orgs/${org.id}/inbox`);
      if (!res.ok) return [];
      return (await res.json()).items ?? [];
    })
    .catch(() => []);
}

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

const DECOY = `journey-baseline-${Date.now()}`;

test.afterAll(() => {
  kubectl('delete', 'deployment', WORKLOAD, '-n', NAMESPACE, '--ignore-not-found');
  kubectl('delete', 'deployment', DECOY, '-n', NAMESPACE, '--ignore-not-found', '--wait=false');
});

/** Open alert instances the hub is holding for this cluster. */
async function openAlertInstances(page: Page): Promise<Array<{ current_issue?: { name?: string } }>> {
  return page
    .evaluate(async () => {
      const orgs = await (await fetch('/api/orgs')).json();
      const org = Array.isArray(orgs) ? orgs[0] : (orgs.orgs ?? [])[0];
      if (!org?.id) return [];
      const res = await fetch(`/api/orgs/${org.id}/alerts/instances?status=open`);
      return res.ok ? ((await res.json()).instances ?? []) : [];
    })
    .catch(() => []);
}

/**
 * Make sure the alert rule has already baselined this cluster.
 *
 * A rule's FIRST poll of a cluster records whatever is broken without
 * notifying. A workload created before that poll is swept into the baseline
 * and never raises anything - which is correct behaviour, and which made an
 * earlier version of this journey report a missing notification on a product
 * that was working. A throwaway broken workload forces the baseline poll and
 * proves it happened; everything created afterwards goes through the real
 * open path. The same technique as alerts.spec.ts, for the same reason.
 */
async function forceBaseline(page: Page): Promise<boolean> {
  kubectl('create', 'deployment', DECOY, `--image=${BAD_IMAGE}`, '-n', NAMESPACE);
  const fired = await expect
    .poll(async () => (await openAlertInstances(page)).some((i) => i.current_issue?.name === DECOY), {
      timeout: 180_000,
      intervals: [5000, 5000, 10_000],
    })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  kubectl('delete', 'deployment', DECOY, '-n', NAMESPACE, '--ignore-not-found', '--wait=false');
  return fired;
}

test('a workload that breaks is detected and can be found everywhere the operator looks', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // The alert rule has to have baselined this cluster BEFORE the workload
  // exists, or its breakage is recorded silently and the notification checks
  // below would be asking for something that correctly never happens.
  const baselined = await forceBaseline(page);
  testInfo.annotations.push({
    type: 'notification',
    description: `alert baseline forced: ${baselined ? 'confirmed by a decoy alert instance' : 'never confirmed'}`,
  });

  kubectl('create', 'deployment', WORKLOAD, `--image=${BAD_IMAGE}`, '-n', NAMESPACE);

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

  // Whether anyone who is NOT looking at the page gets told is recorded, not
  // demanded.
  //
  // On a fresh cluster nothing reached the inbox within three minutes, on both
  // variants. That is not established as a defect: notifications come from an
  // alert rule, the harness runs rules on a 60s +/- 15s poll, and whether a
  // freshly created org has a default rule that notifies at all is not
  // something this repo establishes. Asserting it would file a defect this
  // suite has not verified - the same reason the drawer's missing NEXT STEP is
  // recorded rather than failed.
  //
  // Both layers are recorded separately, because they fail differently: an
  // alert instance that never opens is a rule problem, and an instance that
  // opens without a notification is a delivery problem.
  // With the baseline confirmed, a critical issue raised afterwards MUST reach
  // the inbox: the default rule is enabled, filters on critical, and has
  // inbox delivery on. This is now an assertion rather than a note.
  if (baselined) {
    await expect
      .poll(async () => (await unreadNotifications(page)).length, {
        message:
          `${NAMESPACE}/${WORKLOAD} broke after the alert rule had demonstrably baselined this cluster, and ` +
          `nothing reached the notification inbox - the only people who find out are the ones already looking`,
        timeout: 240_000,
        intervals: [5000, 10_000, 15_000],
      })
      .toBeGreaterThan(0);
  }

  const notifications = await unreadNotifications(page);
  const rules = await page
    .evaluate(async () => {
      const orgs = await (await fetch('/api/orgs')).json();
      const org = Array.isArray(orgs) ? orgs[0] : (orgs.orgs ?? [])[0];
      if (!org?.id) return { rules: 0, instances: 0 };
      const r = await fetch(`/api/orgs/${org.id}/alerts/rules`);
      const i = await fetch(`/api/orgs/${org.id}/alerts/instances?status=open`);
      const rj = r.ok ? await r.json() : {};
      const ij = i.ok ? await i.json() : {};
      return { rules: (rj.rules ?? []).length, instances: (ij.instances ?? []).length };
    })
    .catch(() => ({ rules: -1, instances: -1 }));

  testInfo.annotations.push({
    type: 'notification',
    description:
      `after ${WORKLOAD} broke: ${notifications.length} unread notification(s), ` +
      `${rules.rules} alert rule(s), ${rules.instances} open alert instance(s)`,
  });

  if (notifications.length) {
    await page.getByRole('button', { name: /Notifications/i }).first().click();
    await page.waitForTimeout(2500);
    await captureSurface(page, testInfo, 'journey-broken-notified');
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

  // Recorded for the same reason as the arrival above: if a notification was
  // raised when this broke, a resolution should follow it, but nothing here
  // establishes that a notification was raised in the first place.
  const after = await unreadNotifications(page);
  testInfo.annotations.push({
    type: 'notification',
    description:
      `after ${WORKLOAD} was fixed: ${after.length} unread notification(s), ` +
      `${after.filter((n) => /resolved|cleared/i.test(n.kind)).length} of them resolutions`,
  });

  await captureSurface(page, testInfo, 'journey-broken-resolved');
});
