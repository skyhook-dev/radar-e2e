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
  // Captured inside the poll, not re-fetched after it. A pod that has just
  // failed to pull flaps between ErrImagePull and ImagePullBackOff, and the
  // issue can be absent for a moment - so reading it again after the poll
  // succeeded crashed on undefined.
  let detected: FleetIssue | undefined;
  await expect
    .poll(async () => {
      detected = ours(await fleetIssues(page));
      return Boolean(detected);
    }, {
      message:
        `${NAMESPACE}/${WORKLOAD} was created with an image that cannot be pulled, but no issue for it ever ` +
        `reached /api/fleet/issues - either radar did not detect it or the fan-out to the hub is broken`,
      timeout: 180_000,
      intervals: [3000, 3000, 5000, 5000, 10_000],
    })
    .toBe(true);

  const issue = detected as FleetIssue;
  expect
    .soft(issue.cluster_id, 'the issue is not attributed to the cluster it came from')
    .toBe(clusterId);

  // Recorded rather than asserted: how the failure is worded differs between
  // the build from main and the published release, and this suite is not the
  // place to pin one release's phrasing on the other.
  testInfo.annotations.push({
    type: 'issue',
    description: `${WORKLOAD}: severity=${issue.severity}, reason=${issue.reason ?? '(none)'}`,
  });
  expect
    .soft(issue.severity, 'the issue carries no severity, so no alert rule could ever match it')
    .toBeTruthy();

  // Now the surfaces. Each is soft: the point of this test is to report every
  // place it is missing from, not to stop at the first.
  const surfaces: { path: string; label: string; why: string }[] = [
    { path: '/', label: 'dashboard', why: 'the page an operator lands on does not mention the workload that just broke' },
    { path: '/issues', label: 'issues', why: 'the triage queue does not list the broken workload' },
    { path: '/applications', label: 'applications', why: 'the workload is not listed as an application' },
    { path: '/resources', label: 'resources', why: 'the pod stuck pulling its image is not in the resource table' },
  ];

  // Checked in parallel, one tab per surface. These are four independent
  // reads of the same fact, and doing them one after another spends the sum of
  // four page loads to learn nothing extra. They share the signed-in context,
  // so no extra authentication is involved.
  const results = await Promise.all(
    surfaces.map(async ({ path, label, why }) => {
      const tab = await page.context().newPage();
      try {
        await gotoWhenNotRateLimited(tab, path);

        // Resources defaults to Pods and paginates, so the workload is
        // searched for by name rather than expected to be on screen already.
        if (path === '/resources') {
          const search = tab.getByPlaceholder('Search... (press /)').first();
          if (await search.count()) {
            await search.fill(WORKLOAD);
            await tab.waitForTimeout(3000);
          }
        }

        // Longer than the sequential version needed. Four tabs at once spend
        // the fleet request budget four times as fast, so a tab can lose its
        // turn and have to wait the limit out before it sees anything - which
        // is not the page failing to list the workload.
        const found = await expect
          .poll(async () => (await tab.evaluate(() => document.body.innerText)).includes(WORKLOAD), {
            timeout: 120_000,
            intervals: [2000, 3000, 5000, 10_000],
          })
          .toBe(true)
          .then(() => true)
          .catch(() => false);

        await captureSurface(tab, testInfo, `journey-broken-on-${label}`);
        return { found, path, why };
      } finally {
        await tab.close();
      }
    }),
  );

  for (const { found, path, why } of results) {
    expect.soft(found, `${path}: ${why}`).toBe(true);
  }

  // With the baseline confirmed, a critical issue raised afterwards MUST reach
  // the inbox: the default rule is enabled, filters on critical, and has inbox
  // delivery on.
  //
  // Gated on the issue actually BEING critical. The rule notifies on critical
  // only, and the two variants classify this failure differently - demanding a
  // notification for an issue the rule was never meant to match would report a
  // correctly configured product as broken.
  const notifiable = (issue.severity ?? '').toLowerCase() === 'critical';
  testInfo.annotations.push({
    type: 'notification',
    description: `severity=${issue.severity}, rule filters critical -> ${notifiable ? 'a notification is required' : 'no notification is expected'}`,
  });

  if (baselined && notifiable) {
    // Given a longer budget on purpose. A hub minutes old produced nothing in
    // four minutes while a hub that had been up for a day held hundreds, so
    // "slower than four minutes here" and "never delivered" are the two
    // candidates and they need separating. The elapsed time is recorded either
    // way, so the answer is in the report rather than in someone's memory.
    const started = Date.now();
    const arrived = await expect
      .poll(async () => (await unreadNotifications(page)).length, {
        timeout: 480_000,
        intervals: [5000, 10_000, 15_000, 30_000],
      })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false);

    const openInstances = await openAlertInstances(page);
    testInfo.annotations.push({
      type: 'notification',
      description: arrived
        ? `inbox notified after ${Math.round((Date.now() - started) / 1000)}s`
        : `no notification after ${Math.round((Date.now() - started) / 1000)}s, with ${openInstances.length} open alert instance(s)`,
    });

    expect
      .soft(
        arrived,
        `${NAMESPACE}/${WORKLOAD} is a critical issue raised after the rule demonstrably baselined this cluster, ` +
          `the rule is enabled with inbox delivery on, and ${openInstances.length} alert instance(s) are open - ` +
          `but nothing reached the notification inbox in eight minutes`,
      )
      .toBe(true);
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
  // Captured inside the poll, not re-fetched after it. A pod that has just
  // failed to pull flaps between ErrImagePull and ImagePullBackOff, and the
  // issue can be absent for a moment - so reading it again after the poll
  // succeeded crashed on undefined.
  let detected: FleetIssue | undefined;
  await expect
    .poll(async () => {
      detected = ours(await fleetIssues(page));
      return Boolean(detected);
    }, {
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
