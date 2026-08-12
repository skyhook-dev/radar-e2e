import { test, expect } from '@playwright/test';
import { assertClusterConnected, captureSurface, kubectl, resourceKindNav, sidebarKindCount } from './helpers';

// Resources browser end-to-end, against the PUBLISHED kubectl-radar binary
// serving its own UI. The chain under test:
//
//   kubectl creates a Deployment -> radar's own informer cache (in the same
//   process, reading ~/.kube/config directly - no hub, no tunnel) -> the
//   Resources page renders kind counts and, on drill-down, the real workload
//   detail (replicas, pods).
//
// Everything this spec creates lives in its own `e2e-resources` namespace so
// it can't collide with the other specs' fixtures on the shared kind cluster.

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
    // pause:3.9 - a minimal, side-effect-free image; nobody inspects its content.
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

test.beforeAll(() => {
  ensureProbeDeployment();
});

test('kind counts on the Resources page match the cluster', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // Truth from kubectl, read right before the UI is asked to agree with it.
  // Deployment/Pod are namespaced (exercise the per-kind counts endpoint
  // across every namespace); Namespace is cluster-scoped - a completely
  // separate discovery path, not the per-namespace informer.
  const kinds: Record<string, () => number> = {
    Deployment: () => kubectlItemCount('deployments', '-A'),
    Pod: () => kubectlItemCount('pods', '-A'),
    Namespace: () => kubectlItemCount('namespaces'),
  };

  await page.goto('/resources');

  for (const [kind, countInCluster] of Object.entries(kinds)) {
    // Re-read the cluster on every poll rather than snapshotting it once up
    // front - a count taken before the page loads is stale the moment
    // anything else in the cluster changes (another spec's fixture rolling
    // out), and a stale target can never be matched.
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

  await page.goto('/resources');
  await resourceKindNav(page).getByRole('button', { name: /^Deployment\b/ }).click();

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
    `workload detail shows a different replica count than kubectl (kubectl: ${ready}/${desired})`,
  ).toHaveText(`${ready}/${desired}`);

  // Switch to the Pod kind and narrow by name via the table's own search.
  await resourceKindNav(page).getByRole('button', { name: /^Pod\b/ }).click();
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

  await captureSurface(page, testInfo, 'workload-detail-replicas');
});
