import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl } from './helpers';

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

  await testInfo.attach('resources-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
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

  await testInfo.attach('workload-drawer.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
