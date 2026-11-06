import { test, expect, request as playwrightRequest } from '@playwright/test';
import { assertClusterConnected, captureSurface, clusterId, kubectl } from './helpers';

// Confirmed product defects, pinned so they cannot be forgotten.
//
// Each test here is written as if the product worked and marked `test.fail()`.
// Playwright requires it to fail; the run turns RED the moment it starts
// passing, which is the signal that the bug is fixed and both the marker and
// the KNOWN-ISSUES.md entry should go. A skipped test would rot in silence.
//
// See KNOWN-ISSUES.md for the reproduction and the mechanism.

const NAMESPACE = 'e2e-known-issues';
const WORKLOAD = `known-issue-broken-${Date.now()}`;

// The fleet fan-out caches responses for 5s. Every read below waits past that
// window - without it the stale payload makes the bug look absent, which is
// exactly how this was nearly dismissed when first investigated.
const FLEET_CACHE_MS = 6_000;

async function setNamespaceScope(page: import('@playwright/test').Page, namespaces: string[]) {
  const res = await page.request.post(`/c/${clusterId}/api/cluster/namespace`, {
    headers: { 'X-Hub-Auth': '1' },
    data: { namespaces },
  });
  expect(res.status(), 'setting the namespace switcher scope').toBe(200);
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
  const existing = kubectl('get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'jsonpath={.metadata.name}');
  if (existing !== NAMESPACE) kubectl('create', 'namespace', NAMESPACE);
  kubectl(
    '-n',
    NAMESPACE,
    'create',
    'deployment',
    WORKLOAD,
    '--image=registry.invalid.example/nope:v1',
    '--replicas=1',
  );
});

test.afterAll(async () => {
  kubectl('-n', NAMESPACE, 'delete', 'deployment', WORKLOAD, '--ignore-not-found', '--wait=false');
});

// Was KNOWN ISSUE 1 (fleet reads inheriting one cluster's namespace pick), now
// fixed and released on both legs: the hub fleet fan-out sends globalNs=1
// (radar-hub #308, released v1.12.0+) and radar no longer lets REST reads
// inherit the saved pick (radar #2067, released v1.18.0+). Kept as a normal
// regression test that the fleet view stays fleet-wide; it turns red again if
// either side regresses.
test('fleet Issues is not narrowed by a single cluster\'s namespace pick', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await assertClusterConnected(page);

  // Establish the workload IS detectable fleet-wide, so a failure below can
  // only mean the namespace pick hid it - not that detection never happened.
  await setNamespaceScope(page, []);
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/fleet/issues');
        if (res.status() === 429) return false;
        const body = await res.json();
        return (body.issues ?? []).some((i: { name: string }) => i.name === WORKLOAD);
      },
      {
        message: `${WORKLOAD} was never detected fleet-wide at all - this test cannot say anything about namespace scoping until it is`,
        timeout: 90_000,
        intervals: [2000, 3000, 5000],
      },
    )
    .toBe(true);

  // Now narrow the switcher to an unrelated namespace, exactly as a user does
  // when they focus one namespace in a cluster view.
  await setNamespaceScope(page, ['kube-system']);
  await page.waitForTimeout(FLEET_CACHE_MS);

  const res = await page.request.get('/api/fleet/issues');
  expect(res.status(), 'fleet issues endpoint').toBe(200);
  const issues = (await res.json()).issues ?? [];

  // The picture IS the defect: a fleet-wide Issues page showing all-clear while
  // a critical image-pull failure is live in another namespace. Worth capturing
  // on every run - it is the most persuasive artifact this suite produces, and
  // the day it stops looking like this is the day the bug is fixed.
  await page.goto('/issues');
  await captureSurface(page, testInfo, 'fleet-issues-hidden-by-namespace-pick');

  // Restore before asserting, so a failure here cannot leave the shared
  // account scoped and break every later scenario.
  await setNamespaceScope(page, []);

  expect(
    issues.some((i: { name: string }) => i.name === WORKLOAD),
    'a fleet-wide view must not be narrowed by one cluster\'s namespace switcher - a critical issue disappeared from the fleet Issues feed',
  ).toBe(true);
});

// Was KNOWN ISSUE 2: /api/auth/dev-signin was mounted unconditionally, so an
// unauthenticated caller could create user rows on any hub. Fixed in radar-hub
// #384 (the handler returns 404 unless dev bypass is on) - but that fix is NOT
// in a release yet (latest is v1.14.1), so this asserts the fix and is expected
// to pass on the `main` leg and to stay RED on the `published` leg until the
// next radar-hub release ships #384, which auto-greens it with no change here.
test('the dev-bypass sign-in endpoint is not exposed when dev bypass is off', async ({ page }) => {
  // Deliberately session-less: a Playwright API context inherits the project's
  // saved admin session unless storage state is cleared, which would make this
  // pass for entirely the wrong reason.
  const anonymous = await playwrightRequest.newContext({
    baseURL: process.env.HUB_URL ?? 'http://localhost:18080',
    storageState: { cookies: [], origins: [] },
  });
  const res = await anonymous.post('/api/auth/dev-signin', {
    headers: { 'X-Hub-Auth': '1' },
    // Don't follow redirects: a 3xx landing on some unrelated 404 must not count
    // as the endpoint being gated. We want the endpoint's own status.
    maxRedirects: 0,
    data: { email: `unauthenticated-probe-${Date.now()}@example.invalid` },
  });
  const status = res.status();
  await anonymous.dispose();

  // 404 specifically (the handler's "dev bypass is off" guard), not merely
  // "not 200" - a 429 from rate-limiting or a 500 would otherwise masquerade as
  // the endpoint being disabled.
  expect(
    status,
    'POST /api/auth/dev-signin should be 404 when dev bypass is off; any other status means the unauthenticated user-creation endpoint is still reachable',
  ).toBe(404);
});
