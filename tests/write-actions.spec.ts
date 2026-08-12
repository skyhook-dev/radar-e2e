import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl, captureSurface } from './helpers';

// Write-path end-to-end. Every other spec in this suite only reads what
// radar already pulled from the cluster. This one causes a change FROM the
// hub UI and travels the opposite direction through the tunnel:
//
//   browser click -> hub API -> tunnel -> radar -> impersonated write against
//   the Kubernetes API -> kubectl sees the real change.
//
// That's a different failure surface than the read path: RBAC via user
// impersonation can reject a write while every read continues to work
// perfectly, so a green read-only suite says nothing about this. Every
// assertion below reads the outcome back with kubectl, never the UI's own
// optimistic state.
//
// Everything lives in a dedicated `e2e-writes` namespace, scale/restart/
// delete only ever target the one deployment this spec owns
// (`write-actions-probe`), and its footprint stays at 1-2 replicas.
//
// The three tests below share state on purpose, in ascending replica count -
// scale (1->2), restart (at 2), delete one pod (at 2, replaced back to 2) -
// the same "each test builds on the cluster state the last one left" style
// timeline.spec.ts and resources.spec.ts already use. They must run in this
// order (single worker, default in-file order per playwright.config.ts).

const NAMESPACE = 'e2e-writes';
const DEPLOYMENT = 'write-actions-probe';
const START_REPLICAS = 1;
const SCALED_REPLICAS = 2;

// pause:3.9 doesn't trap SIGTERM, so the default 30s grace period would make
// the delete-pod test wait out a full grace period for no reason - trim it
// so "the pod is gone" resolves in seconds, not half a minute.
const GRACE_PERIOD_SECONDS = 5;

type PodIdentity = { name: string; uid: string };

function ensureNamespace(): void {
  const existing = kubectl(
    'get',
    'namespace',
    NAMESPACE,
    '--ignore-not-found',
    '-o',
    'jsonpath={.metadata.name}',
  );
  if (existing !== NAMESPACE) kubectl('create', 'namespace', NAMESPACE);
}

/** Idempotent: resets the probe to a known replica count whether this is a fresh cluster or a rerun. */
function ensureProbeDeployment(): void {
  ensureNamespace();
  try {
    kubectl('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE);
    kubectl('scale', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, `--replicas=${START_REPLICAS}`);
  } catch {
    kubectl(
      'create',
      'deployment',
      DEPLOYMENT,
      '-n',
      NAMESPACE,
      '--image=registry.k8s.io/pause:3.9',
      `--replicas=${START_REPLICAS}`,
    );
  }
  kubectl(
    'patch',
    'deployment',
    DEPLOYMENT,
    '-n',
    NAMESPACE,
    '--type=json',
    '-p',
    `[{"op":"replace","path":"/spec/template/spec/terminationGracePeriodSeconds","value":${GRACE_PERIOD_SECONDS}}]`,
  );
  kubectl('rollout', 'status', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, '--timeout=60s');
}

function getDeployment(): {
  spec: { replicas: number; template: { metadata: { annotations?: Record<string, string> } } };
  status: { replicas?: number; readyReplicas?: number };
} {
  return JSON.parse(kubectl('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE, '-o', 'json'));
}

function getProbePods(): PodIdentity[] {
  const out = kubectl('get', 'pods', '-n', NAMESPACE, '-l', `app=${DEPLOYMENT}`, '-o', 'json');
  return (JSON.parse(out).items as Array<{ metadata: { name: string; uid: string } }>).map((p) => ({
    name: p.metadata.name,
    uid: p.metadata.uid,
  }));
}

function podExists(name: string): boolean {
  const out = kubectl('get', 'pod', name, '-n', NAMESPACE, '--ignore-not-found', '-o', 'jsonpath={.metadata.name}');
  return out === name;
}

/** Same sidebar-badge lookup resources.spec.ts uses - duplicated locally since helpers.ts is out of scope for this spec. */
function sidebarKindButton(page: Page, kind: string) {
  return page.locator('nav').getByRole('button', { name: new RegExp(`^${kind}\\b`) }).first();
}

async function openDeploymentDrawer(page: Page) {
  await page.goto(`/c/${clusterId}/resources`);
  await sidebarKindButton(page, 'Deployment').click();
  const table = page.getByRole('table').first();
  const row = table.getByRole('row').filter({ hasText: DEPLOYMENT });
  await expect(row.first(), `no Deployment row for ${DEPLOYMENT} - kubectl confirms it exists`).toBeVisible();
  await row.first().click();
  // Drawer identifies the resource by name in its <h2> header - confirms the right one opened.
  await expect(page.getByRole('heading', { name: DEPLOYMENT })).toBeVisible();
}

/** "Replicas" renders as label/value siblings: <span>Replicas</span><span>{ready}/{desired}</span> (see resources.spec.ts). */
function replicasValueLocator(page: Page) {
  return page.getByText('Replicas', { exact: true }).locator('xpath=following-sibling::span[1]');
}

// The delete button on both the Deployment and Pod drawers renders as a bare
// icon - no aria-label, no title, no accessible name at all (confirmed by
// dumping every button's text/aria-label/title while exploring this build).
// That is itself a minor accessibility gap, but not the product bug this
// spec is chartered to hunt for, so this selector targets it by its Lucide
// icon class instead. It is the only trash2 icon on the page while a drawer
// is open.
function deleteResourceButton(page: Page) {
  return page.locator('button:has(svg.lucide-trash2)');
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
  ensureProbeDeployment();
});

test('scaling a deployment from the UI changes the cluster and the UI reflects it', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  const before = getDeployment();
  expect(before.spec.replicas, 'probe deployment did not start at the expected replica count').toBe(START_REPLICAS);

  await openDeploymentDrawer(page);

  await page.getByRole('button', { name: 'Scale' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog, 'no Scale dialog opened').toBeVisible();
  await expect(dialog.getByText(`Scale ${DEPLOYMENT}`)).toBeVisible();

  await dialog.locator('input').first().fill(String(SCALED_REPLICAS));
  await dialog.getByRole('button', { name: 'Apply' }).click();

  // Cluster truth: the Deployment's desired AND ready replica count both
  // land on the target - not just that the API call was accepted.
  await expect
    .poll(
      () => {
        const d = getDeployment();
        return { desired: d.spec.replicas, ready: d.status.readyReplicas ?? 0 };
      },
      {
        message: `kubectl never showed ${DEPLOYMENT} scaled to ${SCALED_REPLICAS} replicas after clicking Scale in the UI`,
        timeout: 30_000,
        intervals: [1000, 2000, 3000],
      },
    )
    .toEqual({ desired: SCALED_REPLICAS, ready: SCALED_REPLICAS });

  // And the UI itself agrees with that cluster truth, on the same open drawer.
  await expect
    .poll(() => replicasValueLocator(page).textContent(), {
      message: `Deployment drawer never showed ${SCALED_REPLICAS}/${SCALED_REPLICAS} replicas after the scale kubectl confirms happened`,
      timeout: 15_000,
      intervals: [500, 1000, 2000],
    })
    .toBe(`${SCALED_REPLICAS}/${SCALED_REPLICAS}`);

  await captureSurface(page, testInfo, 'workload-scaled');
});

test('restarting a workload from the UI replaces its pods', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await assertClusterConnected(page);

  const before = getProbePods();
  expect(before.length, `expected ${SCALED_REPLICAS} probe pods before restarting - previous scale step did not leave the cluster in the expected state`).toBe(SCALED_REPLICAS);
  const beforeUids = new Set(before.map((p) => p.uid));
  const beforeRestartedAt = getDeployment().spec.template.metadata.annotations?.['kubectl.kubernetes.io/restartedAt'];

  const triggeredAt = Date.now();
  await openDeploymentDrawer(page);
  await page.getByRole('button', { name: 'Restart' }).click();

  // Cluster truth for "this was a real rollout restart, not a no-op": the pod
  // template gets a fresh restartedAt annotation strictly after the click.
  await expect
    .poll(
      () => getDeployment().spec.template.metadata.annotations?.['kubectl.kubernetes.io/restartedAt'],
      {
        message: `${DEPLOYMENT}'s pod template never got a new restartedAt annotation after clicking Restart - kubectl.kubernetes.io/restartedAt stayed at "${beforeRestartedAt}"`,
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      },
    )
    .not.toBe(beforeRestartedAt);
  const restartedAt = getDeployment().spec.template.metadata.annotations!['kubectl.kubernetes.io/restartedAt'];
  expect(
    new Date(restartedAt).getTime(),
    `restartedAt annotation (${restartedAt}) predates the moment Restart was clicked`,
  ).toBeGreaterThanOrEqual(triggeredAt - 1000); // small slack for clock skew between this machine and the cluster

  // Cluster truth for "the pods actually got replaced": every pod backing
  // the deployment now has a UID that did not exist before the restart, and
  // the desired replica count is ready again post-rollout.
  await expect
    .poll(
      () => {
        const current = getProbePods();
        const ready = getDeployment().status.readyReplicas ?? 0;
        const allNew = current.length === SCALED_REPLICAS && current.every((p) => !beforeUids.has(p.uid));
        return allNew && ready === SCALED_REPLICAS;
      },
      {
        message: `pods for ${DEPLOYMENT} were not fully replaced after Restart - some pre-restart UIDs are still present, or ready replicas never returned to ${SCALED_REPLICAS}`,
        timeout: 60_000,
        intervals: [1000, 2000, 3000],
      },
    )
    .toBe(true);

  const after = getProbePods();
  const beforeNames = new Set(before.map((p) => p.name));
  for (const pod of after) {
    expect(beforeNames.has(pod.name), `pod ${pod.name} survived the restart - it existed under the same name before Restart was clicked`).toBe(false);
  }

  await testInfo.attach('restart-result.json', {
    body: JSON.stringify({ before, after, restartedAt }, null, 2),
    contentType: 'application/json',
  });
  await captureSurface(page, testInfo, 'workload-restarted');
});

test('deleting a pod from the UI removes it and the deployment replaces it', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await assertClusterConnected(page);

  const before = getProbePods();
  expect(before.length, `expected ${SCALED_REPLICAS} probe pods before deleting one - previous restart step did not leave the cluster in the expected state`).toBe(SCALED_REPLICAS);
  const target = before[0];

  await page.goto(`/c/${clusterId}/resources`);
  await sidebarKindButton(page, 'Pod').click();
  await page.getByPlaceholder('Search... (press /)').fill(target.name);

  const podTable = page.getByRole('table').first();
  const row = podTable.getByRole('row').filter({ hasText: target.name });
  await expect(row.first(), `no Pod row for ${target.name} - kubectl confirms it exists`).toBeVisible();
  await row.first().click();
  await expect(page.getByText(target.name).first()).toBeVisible();

  await deleteResourceButton(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog, 'no delete confirmation dialog opened').toBeVisible();
  await expect(
    dialog,
    `delete confirmation did not name the pod being deleted (${target.name})`,
  ).toContainText(target.name);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

  // Cluster truth: the exact pod (by name, which is UID-stable in k8s - a pod
  // is never renamed or reused) is gone, and the deployment is back to its
  // desired ready count via a genuinely new pod, not the one just deleted.
  await expect
    .poll(() => !podExists(target.name), {
      message: `pod ${target.name} still exists in the cluster ${GRACE_PERIOD_SECONDS}s+ after confirming delete in the UI`,
      timeout: 30_000,
      intervals: [500, 1000, 2000],
    })
    .toBe(true);

  await expect
    .poll(
      () => {
        const current = getProbePods();
        const ready = getDeployment().status.readyReplicas ?? 0;
        return current.length === SCALED_REPLICAS && !current.some((p) => p.uid === target.uid) && ready === SCALED_REPLICAS;
      },
      {
        message: `deployment ${DEPLOYMENT} never replaced the deleted pod - expected ${SCALED_REPLICAS} ready pods with no trace of uid ${target.uid}`,
        timeout: 30_000,
        intervals: [1000, 2000, 3000],
      },
    )
    .toBe(true);

  await captureSurface(page, testInfo, 'pod-deleted-replaced');
});
