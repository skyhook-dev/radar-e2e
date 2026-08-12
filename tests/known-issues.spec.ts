import { test, expect } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl } from './helpers';

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

test('fleet Issues ignores a single cluster\'s namespace pick', async ({ page }) => {
  test.fail(
    true,
    'KNOWN ISSUE 1: the hub fleet fan-out sends no namespace and no globalNs, so fleet reads inherit the per-user namespace-switcher pick. See KNOWN-ISSUES.md.',
  );
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

  // Restore before asserting, so a failure here cannot leave the shared
  // account scoped and break every later scenario.
  await setNamespaceScope(page, []);

  expect(
    issues.some((i: { name: string }) => i.name === WORKLOAD),
    'a fleet-wide view must not be narrowed by one cluster\'s namespace switcher - a critical issue disappeared from the fleet Issues feed',
  ).toBe(true);
});
