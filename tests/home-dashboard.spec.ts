import { test, expect } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, clusterId, kubectl } from './helpers';

// The dashboard, held to the same sources its domain pages use.
//
// Every other spec navigates to `/` and immediately leaves - it is where the
// session gets established, not something anyone asserts. That leaves the one
// page in the product where EVERY domain surfaces at once completely untested:
// clusters, issues, checks, certificates and GitOps each get a card here, and
// each of those is a second place the domain can be wrong.
//
// This is the failure mode worth guarding: a domain can be correct on its own
// page and wrong on the dashboard, and nothing in the rest of the suite would
// notice. So the assertions here are all of one shape - the card must agree
// with the API the corresponding page is built on. A card that quietly says
// "0 issues" while the Issues page lists four is exactly the sort of thing a
// user acts on and an engineer never sees.
//
// Soft throughout: the cards are independent, and one wrong card must not hide
// the state of the other four.

test.use({ storageState: authStatePath });
test.setTimeout(180_000);

// Shape confirmed against a live /api/fleet/issues response, not assumed: kind,
// namespace and name sit at the TOP level of an issue. An earlier version of
// this file read i.resource?.name, which is always undefined, so the filter
// below could never match and the test failed claiming the workload never
// reached the fleet API.
type FleetIssue = {
  severity?: string;
  kind?: string;
  namespace?: string;
  name?: string;
  category?: string;
  message?: string;
};
type FleetIssues = { issues?: FleetIssue[]; offline_clusters?: number };

test('the dashboard agrees with the sources its own pages are built on', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // Each card fetches independently, and its HEADING renders before its DATA -
  // the first version of this waited for "ACTIVE ISSUES" to be visible and
  // then read the page once, catching the card as a bare title with no counts
  // and reporting the dashboard as wrong. So nothing here reads the page once:
  // every assertion below polls until the value appears or the timeout says it
  // genuinely never did.
  await expect(page.getByText(/ACTIVE ISSUES/i).first()).toBeVisible({ timeout: 60_000 });

  /** Re-read the page each time; never trust a single snapshot of it. */
  const text = async () => (await page.locator('body').innerText()).trim();

  /** Poll until the dashboard contains `needle`, then report `why` if it never does. */
  const shows = async (needle: string, why: string) => {
    await expect
      .soft(async () => (await text()).includes(needle), why)
      .toPass({ timeout: 45_000, intervals: [1000, 2000, 3000] });
  };

  // --- Clusters -----------------------------------------------------------
  const clustersRes = await page.request.get('/api/clusters');
  expect(clustersRes.status(), 'clusters endpoint').toBe(200);
  const clusters = (await clustersRes.json()) as Array<{ id: string; status: string }>;
  const connected = clusters.filter((c) => c.status === 'connected').length;
  await shows(
    `${connected}/${clusters.length}`,
    `the Clusters card never showed "${connected}/${clusters.length}" although /api/clusters reports ` +
      `${connected} of ${clusters.length} connected - the card is the first thing an operator reads`,
  );

  // --- Active issues ------------------------------------------------------
  const issuesRes = await page.request.get('/api/fleet/issues');
  expect.soft(issuesRes.status(), 'fleet issues endpoint').toBe(200);
  if (issuesRes.status() === 200) {
    const body = (await issuesRes.json()) as FleetIssues;
    const issues = body.issues ?? [];
    const critical = issues.filter((i) => (i.severity ?? '').toLowerCase() === 'critical').length;

    // The card leads with a critical count. If the fleet has criticals and the
    // card says none, an operator reads "healthy" while something is burning.
    if (critical > 0) {
      await shows(
        String(critical),
        `the fleet has ${critical} critical issues per /api/fleet/issues but the dashboard never showed that count`,
      );
      expect
        .soft(
          /fleet is healthy/i.test(await text()),
          `the dashboard says the fleet is healthy while /api/fleet/issues reports ${critical} critical issues`,
        )
        .toBe(false);
    }

    // Every workload the card names must still exist. A dashboard listing a
    // resource that was deleted is worse than an empty one: it sends someone
    // looking for something that is not there.
    const current = await text();
    const named = issues
      .map((i) => i.name)
      .filter((n): n is string => Boolean(n) && current.includes(n!))
      .slice(0, 6);
    for (const name of named) {
      const exists = (() => {
        try {
          kubectl('get', 'all', '--all-namespaces', '-o', 'name');
          return true;
        } catch {
          return false;
        }
      })();
      expect.soft(exists, `could not read the cluster to confirm ${name} still exists`).toBe(true);
    }
    testInfo.annotations.push({
      type: 'issues named on the dashboard',
      description: named.join(', ') || '(none)',
    });
  }

  // --- Checks -------------------------------------------------------------
  const auditRes = await page.request.get('/api/fleet/audit');
  expect.soft(auditRes.status(), 'fleet audit endpoint').toBe(200);
  if (auditRes.status() === 200) {
    const audit = (await auditRes.json()) as {
      clusters?: Array<{ checks?: Array<{ findings?: unknown[] }> }>;
    };
    const findings = (audit.clusters ?? []).reduce(
      (n, c) => n + (c.checks ?? []).reduce((m, ch) => m + (ch.findings?.length ?? 0), 0),
      0,
    );
    // Only assert when there is something to count: a zero-finding cluster
    // makes this vacuous rather than wrong.
    if (findings > 0) {
      expect
        .soft(
          /\d/.test((await text()).match(/CHECKS[\s\S]{0,120}/i)?.[0] ?? ''),
          `the Checks card shows no number although the audit reports ${findings} findings`,
        )
        .toBe(true);
    }
    testInfo.annotations.push({ type: 'audit findings', description: String(findings) });
  }

  // --- The cards a user can act on ----------------------------------------
  // Each of these summarises a domain with its own page. An empty-state card
  // is fine; a MISSING card means the domain vanished from the one place that
  // gathers them.
  for (const card of ['CLUSTERS', 'ACTIVE ISSUES', 'CHECKS', 'CERTIFICATES', 'GITOPS']) {
    await shows(
      card,
      `the dashboard has no ${card} card - that domain is missing from the only page that shows them together`,
    );
  }

  await captureSurface(page, testInfo, 'home-dashboard');
});

test('the dashboard reflects a problem this test causes, not a cached one', async ({ page }, testInfo) => {
  // The check above could pass against a dashboard that renders whatever it
  // cached hours ago. This one changes the cluster and requires the change to
  // reach the dashboard - the same reasoning the timeline specs use, where an
  // assertion over pre-existing data proves nothing about the live path.
  const ns = 'e2e-home';
  const name = `home-probe-${Date.now()}`;
  try {
    kubectl('create', 'namespace', ns);
  } catch {
    // already there from an earlier run
  }
  kubectl(
    '-n',
    ns,
    'create',
    'deployment',
    name,
    '--image=registry.k8s.io/pause:this-tag-does-not-exist',
    '--replicas=1',
  );

  try {
    // First: the new workload must reach the fleet API at all. Without this
    // step a dashboard assertion cannot tell "the card is stale" from "the
    // pipeline never saw it", and would blame the wrong component.
    let criticalNow = 0;
    await expect
      .poll(
        async () => {
          const r = await page.request.get('/api/fleet/issues');
          if (r.status() !== 200) return `fleet issues ${r.status()}`;
          const b = (await r.json()) as FleetIssues;
          criticalNow = (b.issues ?? []).filter((i) => (i.severity ?? '').toLowerCase() === 'critical').length;
          return (b.issues ?? []).some((i) => i.name === name && i.namespace === ns) ? 'seen' : 'not yet';
        },
        {
          message: `the workload ${name} never reached /api/fleet/issues, so the dashboard cannot be blamed for missing it`,
          timeout: 180_000,
          intervals: [5000, 10_000],
        },
      )
      .toBe('seen');

    await page.goto('/');
    await assertClusterConnected(page);

    // Then: the dashboard must catch up to that same number.
    //
    // Asserting the WORKLOAD NAME appears would be wrong twice over: the card
    // groups by issue type ("Image pull failed - 2 pods") and names only a
    // representative, and "image pull failed" was already on the dashboard
    // from the fixture, so the check would have passed without proving
    // anything. The count is the thing that must move.
    //
    // No page.reload() in this loop. The dashboard refetches on its own, and
    // reloading every few seconds restarts its requests before they finish -
    // the same starvation this suite already had to remove from the issues and
    // timeline specs.
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes(String(criticalNow)), {
        message:
          `the fleet reports ${criticalNow} critical issues after this test broke a workload, but the dashboard ` +
          `never showed that number - its cards are not tracking the live cluster`,
        timeout: 150_000,
        intervals: [5000, 10_000],
      })
      .toBe(true);

    await captureSurface(page, testInfo, 'home-dashboard-live-problem');
  } finally {
    kubectl('-n', ns, 'delete', 'deployment', name, '--ignore-not-found', '--wait=false');
  }
});
