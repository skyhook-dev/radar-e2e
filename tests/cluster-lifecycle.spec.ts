import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { authStatePath, clusterId, kubectl, captureSurface } from './helpers';

// What the hub reports when a cluster stops talking to it, and what happens to
// a token once it is rotated.
//
// Every other scenario runs against a healthy, connected cluster, so the only
// connection state any of them ever observes is "connected". That leaves the
// states an operator actually calls support about untested: an agent that went
// away, an agent that came back, routine rotation without downtime, and
// immediate revocation of a leaked token.
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

function currentRadarToken(): string {
  const token = helmCli('get', 'values', 'radar', '--namespace', RADAR_NS, '-o', 'json')
    .replace(/\s/g, '')
    .match(/"token":"([^"]+)"/)?.[1] ?? '';
  expect(token, 'could not read the token radar is currently using').toBeTruthy();
  return token;
}

async function agentTokenStatus(page: Page, token: string): Promise<number> {
  const res = await page.request.get('/api/agent/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status();
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
  const proxied = await page.request.get(`/c/${clusterId}/api/capacity`);
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
    .poll(async () => (await page.request.get(`/c/${clusterId}/api/capacity`)).status(), {
      message: 'cluster-scoped requests still fail after the hub reported the cluster reconnected',
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe(200);

  await page.goto('/clusters');
  await captureSurface(page, testInfo, 'clusters-list-reconnected');
});

test('routine token rotation keeps the cluster usable until the agent switches to the new token', async ({ page }, testInfo) => {
  await waitForStatus(page, 'connected', 'cluster was not connected before rotating its token');
  originalToken = currentRadarToken();

  const res = await page.request.post(`/api/clusters/${clusterId}/rotate-token`, {
    headers: { 'X-Hub-Auth': '1' },
  });
  expect(res.status(), 'routine token rotation was rejected').toBe(200);
  rotatedToken = (await res.json()).token;
  expect(rotatedToken, 'rotate-token returned no token').toMatch(/^rhc_/);
  expect(rotatedToken === originalToken, 'rotation reused the old token').toBe(false);

  expect(await clusterStatus(page), 'routine rotation disconnected the live agent').toBe('connected');
  expect(await agentTokenStatus(page, originalToken), 'the old token was rejected during grace').toBe(200);
  expect(
    (await page.request.get(`/c/${clusterId}/api/capacity`)).status(),
    'cluster requests stopped working during rotation grace',
  ).toBe(200);

  // A fresh handshake must accept the old token during grace, not just leave
  // an already authenticated tunnel open.
  kubectl('-n', RADAR_NS, 'rollout', 'restart', 'deploy/radar');
  kubectl('-n', RADAR_NS, 'rollout', 'status', 'deploy/radar', '--timeout=120s');
  await waitForStatus(page, 'connected', 'the old token could not reconnect during grace');
  await expect.poll(
    async () => (await page.request.get(`/c/${clusterId}/api/capacity`)).status(),
    { message: 'cluster requests failed after reconnecting with the old token', timeout: 60_000 },
  ).toBe(200);

  setRadarToken(rotatedToken);
  await waitForStatus(page, 'connected', 'the new token did not reconnect the agent');
  await expect.poll(() => agentTokenStatus(page, originalToken), {
    message: 'the old token still authenticates after the new token connected',
    timeout: 60_000,
    intervals: [2_000],
  }).toBe(401);
  expect(await agentTokenStatus(page, rotatedToken), 'the new token was rejected after cutover').toBe(200);
  await expect.poll(
    async () => (await page.request.get(`/c/${clusterId}/api/capacity`)).status(),
    { message: 'cluster requests failed after switching to the new token', timeout: 60_000 },
  ).toBe(200);
  await page.goto('/clusters');
  await captureSurface(page, testInfo, 'clusters-list-token-cutover');
});

test('immediate token revocation drops the live tunnel and rejects the old token', async ({
  page,
}, testInfo) => {
  await waitForStatus(page, 'connected', 'cluster was not connected before rotating its token');

  // Whatever radar is currently configured with is, by definition, the token
  // about to be rotated away.
  originalToken = currentRadarToken();

  const res = await page.request.post(`/api/clusters/${clusterId}/rotate-token`, {
    headers: { 'X-Hub-Auth': '1' },
    data: { revoke_now: true },
  });
  expect(
    res.status(),
    'rotate-token was rejected - the break-glass admin should be an owner of the seeded org',
  ).toBe(200);
  rotatedToken = (await res.json()).token;
  expect(rotatedToken, 'rotate-token returned no token').toMatch(/^rhc_/);
  expect(rotatedToken, 'rotate-token returned the same token it was given').not.toBe(originalToken);

  // Immediate revocation must close the live session, not wait for the agent
  // to reconnect with the revoked token.
  await waitForStatus(
    page,
    'disconnected',
    'the tunnel survived immediate token revocation',
  );

  expect(await agentTokenStatus(page, originalToken), 'the revoked token still authenticates').toBe(401);
  expect(
    (await page.request.get(`/c/${clusterId}/api/capacity`)).ok(),
    'cluster requests still succeed after immediate revocation',
  ).toBe(false);
  expect(
    await clusterStatus(page),
    'the cluster reconnected while its agent was still using the rotated-away token - rotation did not actually invalidate it',
  ).toBe('disconnected');

  // This test never navigated - it works entirely through the API - so the page
  // is still blank. Without this the capture photographs about:blank, which
  // also has no theme for the dark pass to detect.
  await page.goto('/clusters');
  await expect(page.getByText(/disconnected/i).first()).toBeVisible();
  await captureSurface(page, testInfo, 'clusters-list-token-rotated');

  // And the new token brings it back, which is what makes the rotation usable
  // rather than merely destructive.
  setRadarToken(rotatedToken);
  await waitForStatus(
    page,
    'connected',
    'the cluster did not reconnect after radar was reconfigured with the rotated token - rotation is a one-way break',
  );
  expect(await agentTokenStatus(page, originalToken), 'the revoked token became valid again').toBe(401);
  await expect.poll(
    async () => (await page.request.get(`/c/${clusterId}/api/capacity`)).status(),
    { message: 'cluster requests failed after recovering from immediate revocation', timeout: 60_000 },
  ).toBe(200);
});
