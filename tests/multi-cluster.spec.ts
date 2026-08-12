import { execFileSync } from 'node:child_process';
import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { authStatePath, clusterId, kubectl, captureSurface } from './helpers';

// Fleet aggregation with more than one cluster connected.
//
// Every other scenario runs against a single cluster, which means the part of
// the product that actually justifies the word "fleet" - merging one answer
// out of N clusters - is never exercised. A single-cluster fan-out returns the
// one cluster's payload unchanged, so a merge that drops, double-counts or
// mis-keys clusters would pass every other test in this suite.
//
// The second cluster is a second radar release pointed at the SAME Kubernetes
// cluster under a second hub cluster record. The hub cannot tell the
// difference - it sees two connected agents - and it keeps the scenario to one
// kind cluster, which matters when this runs on a 2-core CI runner.

const SECOND_NAME = `e2e-kind-2-${Date.now()}`;
const SECOND_RELEASE = 'radar2';
const SECOND_NS = 'radar2';
const HUB_NS = process.env.NS ?? 'radar-hub';
const RADAR_DIR = process.env.RADAR_DIR ?? '../radar';
// Honour the harness's variant. In published mode there is no locally built
// radar image and no source chart to install from - the point of that variant
// is to run exactly what customers get - so the second agent has to come from
// the released chart with its own image tag, like the first one did.
const PUBLISHED = process.env.VARIANT === 'published';

let secondClusterId = '';

function helmCli(...args: string[]): string {
  const ctx = process.env.KUBE_CONTEXT;
  return execFileSync('helm', [...(ctx ? ['--kube-context', ctx] : []), ...args], {
    encoding: 'utf8',
    // The install waits for a rollout; give it room on a slow runner.
    timeout: 10 * 60_000,
  }).trim();
}

async function registerSecondCluster(page: Page): Promise<{ id: string; token: string }> {
  // X-Hub-Auth satisfies the CSRF guard for a non-browser-form call.
  const res = await page.request.post('/api/clusters', {
    headers: { 'X-Hub-Auth': '1' },
    data: { name: SECOND_NAME },
  });
  expect(res.status(), `registering a second cluster (license allows more than one?)`).toBe(201);
  const body = await res.json();
  return { id: body.cluster?.id ?? body.id, token: body.token };
}

test.afterAll(async () => {
  // Leave the stack as we found it: a lingering second cluster would change
  // what every other scenario sees, and a disconnected record would make the
  // Clusters page look broken to the next reader.
  try {
    helmCli('uninstall', SECOND_RELEASE, '--namespace', SECOND_NS, '--ignore-not-found', '--wait');
  } catch {
    // best effort - never mask a real failure with a cleanup error
  }
  try {
    kubectl('delete', 'namespace', SECOND_NS, '--ignore-not-found', '--wait=false');
  } catch {
    // best effort
  }

  // Removing the agent is not enough: the hub keeps the cluster RECORD, which
  // would sit there permanently disconnected, count against the licensed
  // cluster cap, and change what every other scenario sees on the Clusters
  // page and in fleet counts. afterAll has no `request` fixture, so build an
  // API context from the shared signed-in session.
  if (!secondClusterId) return;
  try {
    const api = await playwrightRequest.newContext({
      baseURL: process.env.HUB_URL ?? 'http://localhost:18080',
      storageState: authStatePath,
    });
    await api.delete(`/api/clusters/${secondClusterId}`, { headers: { 'X-Hub-Auth': '1' } });
    await api.dispose();
  } catch {
    // best effort
  }
});

test('a second cluster connects and the fleet aggregates across both', async ({ page }, testInfo) => {
  // Installing a chart and waiting for a tunnel is minutes of real work.
  test.setTimeout(10 * 60_000);

  await page.goto('/');

  const { id, token } = await registerSecondCluster(page);
  secondClusterId = id;

  // Same wss + insecureSkipVerify path the harness uses for the first agent:
  // radar refuses a plain ws:// tunnel to a non-loopback host.
  if (PUBLISHED) {
    // run.sh has already added/updated the skyhook repo for this variant.
    helmCli('repo', 'update', 'skyhook');
  }
  helmCli(
    'upgrade',
    '--install',
    SECOND_RELEASE,
    PUBLISHED ? 'skyhook/radar' : `${RADAR_DIR}/deploy/helm/radar`,
    '--namespace',
    SECOND_NS,
    '--create-namespace',
    ...(PUBLISHED ? [] : ['--set', 'image.repository=radar', '--set', 'image.tag=e2e']),
    '--set',
    'cloud.enabled=true',
    '--set',
    `cloud.url=wss://radar-hub-web.${HUB_NS}.svc.cluster.local/agent`,
    '--set',
    `cloud.clusterName=${SECOND_NAME}`,
    '--set',
    `cloud.token=${token}`,
    '--set',
    'cloud.insecureSkipVerify=true',
    '--wait',
    '--timeout',
    '5m',
  );

  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/clusters');
        if (res.status() !== 200) return 'clusters endpoint ' + res.status();
        const clusters = (await res.json()) as Array<{ id: string; status: string }>;
        const first = clusters.find((c) => c.id === clusterId)?.status;
        const second = clusters.find((c) => c.id === secondClusterId)?.status;
        return first === 'connected' && second === 'connected' ? 'both' : `first=${first} second=${second}`;
      },
      {
        message: `the second cluster never reached connected - a second agent cannot join this hub`,
        timeout: 180_000,
        intervals: [3000, 5000],
      },
    )
    .toBe('both');

  // The Clusters page must show both, not just count them.
  await page.goto('/clusters');
  const table = page.getByRole('table').first();
  await expect(table).toBeVisible();
  await expect(
    table.getByRole('row').filter({ hasText: SECOND_NAME }).first(),
    `the Clusters page has no row for the second cluster ${SECOND_NAME}`,
  ).toBeVisible();

  // And a fleet aggregation must attribute data to BOTH clusters. Packages is
  // the clearest: both agents watch the same Kubernetes cluster, so the same
  // charts are installed in each - a merge that mis-keys or collapses clusters
  // shows up here as a chart present in only one of them.
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/fleet/packages');
        if (res.status() === 429) return 'rate limited, retrying';
        if (res.status() !== 200) return `packages endpoint ${res.status()}`;
        const body = await res.json();
        const rows = (body.packages ?? body.rows ?? []) as Array<{ cells?: Record<string, unknown> }>;
        const withBoth = rows.filter(
          (r) => r.cells && r.cells[clusterId] !== undefined && r.cells[secondClusterId] !== undefined,
        );
        return withBoth.length > 0
          ? 'both clusters contribute'
          : `no package row carries cells for both clusters (rows=${rows.length})`;
      },
      {
        message: 'the fleet Packages pivot never attributed a chart to both connected clusters - cross-cluster merge is broken',
        timeout: 120_000,
        intervals: [3000, 5000],
      },
    )
    .toBe('both clusters contribute');

  await captureSurface(page, testInfo, 'clusters-list-two-connected');
});
