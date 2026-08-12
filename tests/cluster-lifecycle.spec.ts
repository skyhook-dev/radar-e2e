import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { authStatePath, clusterId, kubectl, captureSurface } from './helpers';

// What the hub reports when a cluster stops talking to it, and what happens to
// a token once it is rotated.
//
// Every other scenario runs against a healthy, connected cluster, so the only
// connection state any of them ever observes is "connected". That leaves the
// states an operator actually calls support about untested: an agent that went
// away, an agent that came back, and a token that was rotated because it
// leaked. A hub that reported "connected" forever - or that kept serving proxy
// traffic on a rotated token - would pass the entire rest of this suite.
//
// The disconnect is caused by scaling radar to zero rather than by deleting
// anything, so the cluster record, its token and its history stay exactly as
// they were and the only variable is whether the agent is talking.

const RADAR_NS = process.env.RADAR_NS ?? 'radar';
const HUB_NS = process.env.NS ?? 'radar-hub';
const RADAR_DIR = process.env.RADAR_DIR ?? '../radar';
const HELM_REPO_URL = process.env.HELM_REPO_URL ?? 'https://skyhook-io.github.io/helm-charts';
const PUBLISHED = process.env.VARIANT === 'published';

// Rolling a Deployment and waiting for a tunnel to re-establish is minutes of
// real work, and the steps are a sequence rather than independent cases.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: authStatePath });
test.setTimeout(300_000);

/** The token radar is currently configured with, so it can be restored. */
let originalToken = '';
let rotatedToken = '';

function helmCli(...args: string[]): string {
  const ctx = process.env.KUBE_CONTEXT;
  return execFileSync('helm', [...(ctx ? ['--kube-context', ctx] : []), ...args], {
    encoding: 'utf8',
    timeout: 10 * 60_000,
  }).trim();
}

/** Reconfigure the running radar release with a different cluster token. */
function setRadarToken(token: string) {
  const args = ['upgrade', 'radar'];
  if (PUBLISHED) {
    try {
      helmCli('repo', 'add', 'skyhook', HELM_REPO_URL);
    } catch {
      // already added - `helm repo add` is not idempotent about its exit code
    }
    helmCli('repo', 'update', 'skyhook');
    args.push('skyhook/radar');
  } else {
    args.push(`${RADAR_DIR}/deploy/helm/radar`);
  }
  helmCli(
    ...args,
    '--namespace',
    RADAR_NS,
    '--reuse-values',
    '--set',
    `cloud.token=${token}`,
    '--wait',
    '--timeout',
    '5m',
  );
}

/** The hub's own view of this cluster, which is the source of truth here. */
async function clusterStatus(page: Page): Promise<string> {
  const res = await page.request.get('/api/clusters');
  expect(res.status(), 'clusters endpoint').toBe(200);
  const cluster = (await res.json()).find((c: { id: string }) => c.id === clusterId);
  expect(cluster, `cluster ${clusterId} is not registered with the hub`).toBeTruthy();
  return cluster.status;
}

async function waitForStatus(page: Page, want: string, why: string) {
  await expect
    .poll(() => clusterStatus(page), {
      message: why,
      timeout: 180_000,
      intervals: [2_000],
    })
    .toBe(want);
}

test.afterAll(async ({ browser }) => {
  // Leave the stack connected and on a token the harness knows about. A
  // scenario that ends with a dark cluster would make every later reader of
  // this environment think the product is broken.
  try {
    if (originalToken && rotatedToken) setRadarToken(rotatedToken);
    kubectl('-n', RADAR_NS, 'scale', 'deploy/radar', '--replicas=1');
    kubectl('-n', RADAR_NS, 'rollout', 'status', 'deploy/radar', '--timeout=300s');
    const page = await browser.newPage({ storageState: authStatePath });
    await waitForStatus(page, 'connected', 'cluster did not reconnect during cleanup');
    await page.close();
  } catch {
    // best effort - never mask a real failure with a cleanup error
  }
});

test('the hub reports a cluster as disconnected once its agent stops, not stale-connected', async ({
  page,
}, testInfo) => {
  await waitForStatus(page, 'connected', 'cluster was not connected at the start of the scenario');

  // Scale to zero: the agent goes away, everything else about the cluster
  // record stays untouched.
  kubectl('-n', RADAR_NS, 'scale', 'deploy/radar', '--replicas=0');
  kubectl('-n', RADAR_NS, 'wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/name=radar', '--timeout=120s');

  await waitForStatus(
    page,
    'disconnected',
    'the hub still reports this cluster as connected after its only agent was scaled to zero - a stale status here means an operator cannot tell a working cluster from a dead one',
  );

  await page.goto('/clusters');
  await expect(
    page.getByText(/disconnected/i).first(),
    'the Clusters page does not show the disconnected state the API is reporting',
  ).toBeVisible();
  await captureSurface(page, testInfo, 'clusters-list-disconnected');

  // Cluster-scoped data must fail honestly rather than serve a cached answer
  // that looks live.
  const proxied = await page.request.get(`/c/${clusterId}/api/overview`);
  expect(
    proxied.ok(),
    'the hub served a cluster-scoped response while the cluster was disconnected - stale data presented as live is worse than an error',
  ).toBeFalsy();
});

test('a cluster reconnects on its own once its agent comes back', async ({ page }, testInfo) => {
  kubectl('-n', RADAR_NS, 'scale', 'deploy/radar', '--replicas=1');
  kubectl('-n', RADAR_NS, 'rollout', 'status', 'deploy/radar', '--timeout=300s');

  await waitForStatus(
    page,
    'connected',
    'the cluster never returned to connected after its agent was restored - the agent reconnect loop, or the hub session registry, is not recovering',
  );

  // Reconnected has to mean usable, not just green.
  await expect
    .poll(async () => (await page.request.get(`/c/${clusterId}/api/overview`)).status(), {
      message: 'cluster-scoped requests still fail after the hub reported the cluster reconnected',
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe(200);

  await page.goto('/clusters');
  await captureSurface(page, testInfo, 'clusters-list-reconnected');
});

test('rotating a cluster token drops the live tunnel and the old token no longer works', async ({
  page,
}, testInfo) => {
  await waitForStatus(page, 'connected', 'cluster was not connected before rotating its token');

  // Whatever radar is currently configured with is, by definition, the token
  // about to be rotated away.
  originalToken = helmCli('get', 'values', 'radar', '--namespace', RADAR_NS, '-o', 'json')
    .replace(/\s/g, '')
    .match(/"token":"([^"]+)"/)?.[1] ?? '';
  expect(originalToken, 'could not read the token radar is currently using').toBeTruthy();

  const res = await page.request.post(`/api/clusters/${clusterId}/rotate-token`, {
    headers: { 'X-Hub-Auth': '1' },
  });
  expect(
    res.status(),
    'rotate-token was rejected - the break-glass admin should be an owner of the seeded org',
  ).toBe(200);
  rotatedToken = (await res.json()).token;
  expect(rotatedToken, 'rotate-token returned no token').toMatch(/^rhc_/);
  expect(rotatedToken, 'rotate-token returned the same token it was given').not.toBe(originalToken);

  // The hub kicks the live session on rotation, on purpose: a leaked token must
  // not keep serving proxy traffic until the agent happens to reconnect.
  await waitForStatus(
    page,
    'disconnected',
    'the tunnel survived a token rotation - a leaked token would keep serving traffic until the agent next reconnected',
  );

  // radar is still configured with the OLD token and is retrying continuously.
  // If the old token were still accepted, this is where it would come back.
  await expect
    .poll(() => clusterStatus(page), {
      message: 'checking the old token stays rejected',
      timeout: 45_000,
      intervals: [3_000],
    })
    .toBe('disconnected');
  expect(
    await clusterStatus(page),
    'the cluster reconnected while its agent was still using the rotated-away token - rotation did not actually invalidate it',
  ).toBe('disconnected');

  await captureSurface(page, testInfo, 'clusters-list-token-rotated');

  // And the new token brings it back, which is what makes the rotation usable
  // rather than merely destructive.
  setRadarToken(rotatedToken);
  await waitForStatus(
    page,
    'connected',
    'the cluster did not reconnect after radar was reconfigured with the rotated token - rotation is a one-way break',
  );
});
