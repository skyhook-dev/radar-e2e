import { test, expect } from '@playwright/test';
import { assertClusterConnected, captureSurface, kubectl } from './helpers';

// Topology rendering, against real objects: kubectl creates a Deployment +
// Pods -> radar's topology builder (owner-reference + selector graph, built
// fresh per request from the live informer cache) -> the graph canvas
// renders a node per real object.
//
// Zoomed out, the default topology view groups everything into one node per
// namespace (a deliberate summary for clusters with hundreds of resources) -
// asserting against THAT would only prove a namespace label rendered, not
// that real objects are in the graph. Filtering to this spec's own namespace
// (?namespaces=) collapses the grouping and expands straight to individual
// resource nodes, which is what this spec actually needs to prove.

const NAMESPACE = 'e2e-topology';
const DEPLOYMENT = 'topology-probe';
const REPLICAS = 2;

function ensureProbeDeployment() {
  try {
    kubectl('get', 'namespace', NAMESPACE);
  } catch {
    kubectl('create', 'namespace', NAMESPACE);
  }
  try {
    kubectl('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE);
    kubectl('scale', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, `--replicas=${REPLICAS}`);
  } catch {
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

test.beforeAll(() => {
  ensureProbeDeployment();
});

// `?namespaces=` is not a per-tab URL param the way it looks: RadarApp
// mirrors whatever namespace filter is active back to a server-side
// preference (POST /api/cluster/namespace) that then applies to every
// subsequent request from anyone - including every OTHER spec in this run,
// if they happen to execute afterwards. Reset it explicitly rather than
// relying on test order; discovered the hard way while developing this spec
// (it silently broke resources.spec.ts's cluster-wide counts).
test.afterAll(async ({ request }) => {
  await request.post('/api/cluster/namespace', { data: { namespaces: [] } });
});

test('the topology graph renders this deployment and its real pods, not placeholders', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // Ground truth read right before the graph is asked to agree with it - a
  // pod list snapshotted earlier could already be stale by the time the
  // graph loads.
  const podNames: string[] = JSON.parse(
    kubectl('get', 'pods', '-n', NAMESPACE, '-l', `app=${DEPLOYMENT}`, '-o', 'json'),
  ).items.map((p: { metadata: { name: string } }) => p.metadata.name);
  expect(podNames.length, `kubectl reports ${podNames.length} pods for ${DEPLOYMENT}, expected ${REPLICAS}`).toBe(
    REPLICAS,
  );

  await page.goto(`/topology?namespaces=${NAMESPACE}`);

  const canvas = page.locator('.react-flow');
  await expect(canvas, 'the topology canvas never rendered').toBeVisible({ timeout: 20_000 });

  const nodes = page.locator('.react-flow__node');
  // Deployment node + one Pod node per replica - kubectl's own count, not an
  // assumption about how many the graph "should" have.
  await expect
    .poll(() => nodes.count(), {
      message: `topology graph never reached ${1 + podNames.length} nodes (1 Deployment + ${podNames.length} Pods) for ${NAMESPACE}`,
      timeout: 20_000,
      intervals: [500, 1000, 2000],
    })
    .toBeGreaterThanOrEqual(1 + podNames.length);

  // Every Pod node's name is DEPLOYMENT-<hash>-<hash>, and node text is the
  // kind label glued directly to the name with no separator (textContent:
  // "Deploymenttopology-probe2/2 ready" vs "Podtopology-probe-abc123-xyzRunning")
  // - so a plain substring filter for DEPLOYMENT would also match every Pod
  // node. Anchor on the "Deployment" label immediately before the name, and
  // require a digit (the ready-count) immediately after it, to land on the
  // Deployment node specifically rather than any Pod node.
  await expect(
    page.locator('.react-flow__node').filter({ hasText: new RegExp(`^Deployment${DEPLOYMENT}\\d`) }),
    `no topology node for Deployment ${DEPLOYMENT} - kubectl confirms it exists`,
  ).toHaveCount(1);

  for (const name of podNames) {
    await expect(
      page.locator('.react-flow__node').filter({ hasText: name }),
      `no topology node for pod ${name} (from kubectl) - the graph is not showing real cluster objects`,
    ).toHaveCount(1);
  }

  await captureSurface(page, testInfo, 'topology-real-objects', canvas);
});
