import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl, captureSurface } from './helpers';

// Resources browser end-to-end. The chain under test is:
//
//   kubectl creates a Deployment -> radar's informer cache picks it up ->
//   hub pulls it over the tunnel -> hub serves the resource-counts /
//   resources endpoints -> the Resources page renders kind counts and, on
//   drill-down, the real workload detail (replicas, pods).
//
// Everything this spec creates lives in its own `e2e-resources` namespace, so
// it can't collide with what other specs or other concurrent agents depend
// on (radar, radar-hub, e2e-demo/timeline-probe).
//
// Deliberately NOT covered: the namespace-scope picker ("Switch active
// namespaces"). Discovered while writing this spec that picking a namespace
// there - or even just deep-linking to `?namespaces=...` - is not a
// per-tab UI toggle: RadarApp mirrors whatever namespace filter is active
// back to a per-user, per-cluster server preference
// (`/c/{id}/api/cluster/namespace-scope`), and that preference is then the
// default for every subsequent load by the same account, including other
// agents' concurrent sessions signed in as the same break-glass admin. Kind
// counts below are read from the default "All namespaces" view; the
// drill-down test finds its deployment/pods by their unique name instead of
// by namespace filter, and the table's own text search (`?search=`, not
// persisted) is used in place of the drawer's "View Managed Pods" shortcut,
// which does set `?namespaces=` and would otherwise leak this scope change
// into every other concurrent session.

const NAMESPACE = 'e2e-resources';
const DEPLOYMENT = 'resources-probe';
const REPLICAS = 3;

function ensureNamespace(name: string) {
  try {
    kubectl('get', 'namespace', name);
  } catch {
    kubectl('create', 'namespace', name);
  }
}

/** Idempotent so a rerun against a previous run's leftover deployment still converges on REPLICAS. */
function ensureProbeDeployment() {
  ensureNamespace(NAMESPACE);
  try {
    kubectl('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE);
    kubectl('scale', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, `--replicas=${REPLICAS}`);
  } catch {
    // pause:3.9 is already cached on the kind node (the harness's own
    // timeline-probe deployment uses the same image) - avoids a slow or
    // flaky image pull for a deployment whose content nobody inspects.
    kubectl(
      'create',
      'deployment',
      DEPLOYMENT,
      '-n',
      NAMESPACE,
      '--image=registry.k8s.io/pause:3.9',
      `--replicas=${REPLICAS}`,
    );
  }
  kubectl('rollout', 'status', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, '--timeout=60s');
}

function kubectlItemCount(...args: string[]): number {
  const out = kubectl('get', ...args, '-o', 'json');
  return (JSON.parse(out).items as unknown[]).length;
}

/**
 * Reads a kind's count badge from the Resources sidebar. Label and count are
 * separate text nodes inside the same button, so the accessible name comes
 * out as "<Kind> <count>" once loaded (or "<Kind> –" while a count is
 * still unavailable, which parses to NaN and lets the caller's poll keep
 * waiting instead of matching a false zero).
 */
function sidebarKindButton(page: Page, kind: string) {
  // Scoped to the sidebar <nav>: an open workload drawer can add its own
  // same-named buttons elsewhere on the page (e.g. a "Pod Template" section
  // header), which would otherwise make the kind button ambiguous.
  return page.locator('nav').getByRole('button', { name: new RegExp(`^${kind}\\b`) }).first();
}

async function sidebarKindCount(page: Page, kind: string): Promise<number> {
  const button = sidebarKindButton(page, kind);
  await expect(button).toBeVisible();
  const parts = (await button.innerText()).trim().split(/\s+/).filter(Boolean);
  return Number(parts[parts.length - 1]);
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through e2e/browser/run.sh');
  ensureProbeDeployment();
});

test('kind counts on the Resources page match the cluster', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // Truth from kubectl, read right before the UI is asked to agree with it.
  // Deployment/Pod are namespaced (exercise the per-kind counts endpoint
  // across every namespace); Namespace is cluster-scoped (a completely
  // separate discovery path - not the per-namespace informer).
  const kinds: Record<string, () => number> = {
    Deployment: () => kubectlItemCount('deployments', '-A'),
    Pod: () => kubectlItemCount('pods', '-A'),
    Namespace: () => kubectlItemCount('namespaces'),
  };

  await page.goto(`/c/${clusterId}/resources`);

  for (const [kind, countInCluster] of Object.entries(kinds)) {
    // Re-read the cluster on every poll rather than snapshotting it once up
    // front. A count taken before the page loads is stale the moment anything
    // else in the cluster changes - another scenario's pod terminating, a
    // rollout finishing - and a stale target can never be matched, so the test
    // would fail for a reason that has nothing to do with the Resources page.
    await expect
      .poll(
        async () => {
          const truth = countInCluster();
          const shown = await sidebarKindCount(page, kind);
          return shown === truth ? 'match' : `page=${shown} cluster=${truth}`;
        },
        {
          message: `Resources sidebar ${kind} count never agreed with the cluster`,
          timeout: 30_000,
          intervals: [500, 1000, 2000, 3000],
        },
      )
      .toBe('match');
  }

  await captureSurface(page, testInfo, 'resources-kind-counts');
});

test('drilling into the deployment shows its real replicas and pods', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  const deployment = JSON.parse(kubectl('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE, '-o', 'json'));
  const desired: number = deployment.spec.replicas;
  const ready: number = deployment.status.readyReplicas ?? 0;
  const podNames: string[] = JSON.parse(
    kubectl('get', 'pods', '-n', NAMESPACE, '-l', `app=${DEPLOYMENT}`, '-o', 'json'),
  ).items.map((p: { metadata: { name: string } }) => p.metadata.name);
  expect(podNames.length, `kubectl found ${podNames.length} pods for ${DEPLOYMENT}, expected ${desired}`).toBe(
    desired,
  );

  await page.goto(`/c/${clusterId}/resources`);
  await sidebarKindButton(page, 'Deployment').click();

  const table = page.getByRole('table').first();
  const row = table.getByRole('row').filter({ hasText: DEPLOYMENT });
  await expect(
    row.first(),
    `no Deployment row for ${DEPLOYMENT} - kubectl confirms it exists in the cluster`,
  ).toBeVisible();
  await expect(row.first(), `${DEPLOYMENT} row doesn't show its real namespace ${NAMESPACE}`).toContainText(
    NAMESPACE,
  );

  await row.first().click();

  // "Replicas" renders as label/value siblings: <span>Replicas</span><span>{ready}/{desired}</span>
  const replicasValue = page.getByText('Replicas', { exact: true }).locator('xpath=following-sibling::span[1]');
  await expect(
    replicasValue,
    `workload drawer shows a different replica count than kubectl (kubectl: ${ready}/${desired})`,
  ).toHaveText(`${ready}/${desired}`);

  // Switch to the Pod kind and narrow by name via the table's own search
  // instead of the drawer's "View Managed Pods" shortcut - see the note atop
  // this file on why that shortcut's owner+namespace URL filter is avoided.
  await sidebarKindButton(page, 'Pod').click();
  await page.getByPlaceholder('Search... (press /)').fill(DEPLOYMENT);

  const podTable = page.getByRole('table').first();
  for (const name of podNames) {
    await expect(
      podTable.getByRole('row').filter({ hasText: name }).first(),
      `pod ${name} (from kubectl) is missing from the Resources pod list`,
    ).toBeVisible();
  }
  // Header row + exactly the pods kubectl reports - not more, not fewer.
  await expect(podTable.getByRole('row')).toHaveCount(podNames.length + 1);

  await captureSurface(page, testInfo, 'workload-drawer-replicas');
});

// The resource drawer, opened for every kind the shared fixture provides.
//
// The test above opens the drawer once, for one Deployment, and checks the
// replica count. That leaves the drawer untested for every other kind, and the
// drawer is where a user actually inspects a resource - a kind whose drawer
// throws, renders empty, or shows someone else's resource would fail nothing.
//
// Soft assertions throughout: a broken drawer on one kind must not stop the
// sweep, or each run reveals exactly one bad kind and the next has to start
// over. The fixture namespace is used so each row is a resource with known
// identity rather than whatever happens to sort first.
const FIXTURE_NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';

const DRAWER_KINDS: { kind: string; name: string }[] = [
  { kind: 'Deployment', name: 'storefront' },
  { kind: 'StatefulSet', name: 'ledger' },
  { kind: 'DaemonSet', name: 'node-probe' },
  { kind: 'Job', name: 'migrate-once' },
  { kind: 'CronJob', name: 'nightly-report' },
  { kind: 'Service', name: 'storefront' },
  { kind: 'ConfigMap', name: 'storefront-config' },
  { kind: 'Secret', name: 'storefront-secret' },
];

test('the resource drawer opens and renders the right resource for every kind', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await assertClusterConnected(page);
  await page.goto(`/c/${clusterId}/resources`);

  // Wait for the sidebar ONCE before the loop. isVisible() answers "right now"
  // and never waits, so calling it straight after a navigation reports every
  // kind as missing - which is exactly what it did, producing eight confident
  // failures about a sidebar that was merely still rendering.
  await expect(
    sidebarKindButton(page, 'Deployment'),
    'the Resources sidebar never rendered its kind list',
  ).toBeVisible({ timeout: 30_000 });

  for (const { kind, name } of DRAWER_KINDS) {
    const kindButton = sidebarKindButton(page, kind);
    // Safe now: the sidebar is rendered, so absence here is real absence.
    const listed = await kindButton.isVisible().catch(() => false);
    expect
      .soft(listed, `the Resources sidebar offers no ${kind} entry, though the fixture creates one`)
      .toBe(true);
    if (!listed) continue;

    await kindButton.click();
    const table = page.getByRole('table').first();
    await expect.soft(table, `${kind}: no table rendered after selecting the kind`).toBeVisible({ timeout: 20_000 });

    const row = table.getByRole('row').filter({ hasText: name }).first();
    // Same reasoning: wait for the row rather than sampling instantly.
    const found = await expect(row)
      .toBeVisible({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    expect
      .soft(found, `${kind}: no row for ${FIXTURE_NS}/${name}, which kubectl confirms exists`)
      .toBe(true);
    if (!found) continue;

    await row.click();

    // The drawer names the resource it opened for. Without this a drawer that
    // opens on the wrong row - or keeps the previous kind's content - looks
    // completely healthy.
    await expect
      .soft(
        page.getByRole('heading', { name: new RegExp(`^${name}$`) }).first(),
        `${kind}: the drawer did not open on ${name} - it may have opened the wrong resource or kept the previous one`,
      )
      .toBeVisible({ timeout: 20_000 });

    await expect
      .soft(
        page.getByText(/something went wrong|failed to load|unable to load/i).first(),
        `${kind}: the drawer rendered an error state for ${name}`,
      )
      .toBeHidden({ timeout: 10_000 });

    await captureSurface(page, testInfo, `resource-drawer-${kind.toLowerCase()}`);

    // Close before the next kind: an open drawer adds its own buttons and
    // headings to the page, which is exactly what made the Scale selector in
    // write-actions ambiguous.
    await page.keyboard.press('Escape');
  }
});
