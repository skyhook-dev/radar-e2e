import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertClusterConnected, clusterId, kubectl } from './helpers';

// Problem detection + search end-to-end. The chain under test is:
//
//   kubectl creates a broken workload -> radar's informer cache picks it up
//   -> radar's own detectors (issues) / resource cache (search) compute it
//   -> hub fans out over the tunnel via /api/fleet/{issues,search} -> the
//   Issues and Search pages render it.
//
// Both scenarios reuse one deployment: a single unresolvable-image workload
// is enough evidence for "issues surfaces it" AND "search finds it", and
// keeps the footprint to one broken pod instead of two.

const NAMESPACE = 'e2e-issues';
// Unique per run so the assertions below cannot pass on another agent's
// pre-existing broken workloads or a leftover from a prior run.
const WORKLOAD_NAME = `e2e-broken-${Date.now()}`;

let createdAt = 0;

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through e2e/browser/run.sh');
  ensureNamespace();
  createdAt = Date.now();
  applyBrokenDeployment(WORKLOAD_NAME);
});

test.afterAll(() => {
  // Best-effort: don't let cleanup failure mask a real test failure, and
  // don't block on pod termination - the namespace outlives the run for
  // other agents to reuse.
  try {
    kubectl('-n', NAMESPACE, 'delete', 'deployment', WORKLOAD_NAME, '--ignore-not-found', '--wait=false');
  } catch {
    // ignore
  }
});

function ensureNamespace(): void {
  // Check before creating rather than creating and swallowing the conflict:
  // the swallowed version still prints kubectl's "AlreadyExists" error to the
  // run log, and a scheduled run whose log is full of handled errors trains
  // everyone to ignore the log.
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

// An image on a registry hostname that can never resolve is the simplest
// reliable break: unlike a typo'd-but-real registry, there is no chance of
// it accidentally succeeding, and unlike a crash loop it needs no in-image
// logic. Tiny resource requests + a single replica keep the footprint
// negligible - the container never actually starts.
function applyBrokenDeployment(name: string): void {
  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
  labels:
    e2e-issues-spec: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: main
          image: registry.invalid.example/e2e-issues/${name}:missing
          resources:
            requests:
              cpu: 5m
              memory: 8Mi
            limits:
              cpu: 10m
              memory: 16Mi
`;
  const file = path.join(os.tmpdir(), `${name}.yaml`);
  fs.writeFileSync(file, manifest);
  try {
    kubectl('apply', '-f', file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Radar's per-cluster /api/issues and /api/search both fall back to whatever
 * namespace this shared admin session last had picked in the single-cluster
 * namespace switcher whenever the caller sends no explicit namespace filter
 * - which is exactly how the hub's fleet Issues/Search pages call them (see
 * radar's parseNamespacesForUser). That pick is server-side, per-login state
 * shared by every agent using this one break-glass admin account, so a
 * concurrent agent narrowing their embedded cluster view to one namespace
 * silently narrows fleet-wide Issues/Search for everyone else, with no UI
 * indication (confirmed live: with a stale "e2e-resources" pick left behind
 * by another session, /api/fleet/issues returned zero issues fleet-wide even
 * though a critical one was live). Reset it to "All namespaces" - the same
 * action Radar's own NamespaceSwitcher performs - so this test observes real
 * fleet-wide behavior instead of whatever another agent's browsing left
 * behind.
 */
async function useClusterWideNamespaceScope(page: Page): Promise<void> {
  const res = await page.request.post(`/c/${clusterId}/api/cluster/namespace`, {
    headers: { 'X-Hub-Auth': '1' },
    data: { namespaces: [] },
  });
  expect(res.status(), 'reset the shared admin namespace-switcher scope to All namespaces').toBe(200);
}

test('a broken workload is detected and surfaces on the fleet Issues page, attributed to it', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await useClusterWideNamespaceScope(page);

  // Poll the fleet issues API directly so the timing bound reflects how long
  // detection actually takes, not how long the UI takes to poll/render.
  let detectedAfterMs = 0;
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/fleet/issues');
        // The fleet endpoints share a 30/min/user budget, and the Issues page
        // itself polls them. A 429 means "ask again shortly", not "detection
        // is broken" - so keep polling instead of failing. A permanent 429
        // still fails this poll on timeout, with the message below.
        if (res.status() === 429) return false;
        expect(res.status(), 'fleet issues endpoint').toBe(200);
        const body = (await res.json()) as { issues: Array<{ namespace: string; name: string; kind: string }> };
        const found = body.issues.some((i) => i.namespace === NAMESPACE && i.name === WORKLOAD_NAME && i.kind === 'Deployment');
        if (found) detectedAfterMs = Date.now() - createdAt;
        return found;
      },
      {
        message: `no issue for ${NAMESPACE}/${WORKLOAD_NAME} appeared on /api/fleet/issues - the image-pull failure was never detected, or the radar -> hub issues fan-out is broken`,
        timeout: 45_000,
        intervals: [2000, 2000, 3000, 3000, 5000],
      },
    )
    .toBe(true);

  await testInfo.attach('issue-detection-timing.json', {
    body: JSON.stringify({ namespace: NAMESPACE, name: WORKLOAD_NAME, detectedAfterMs }, null, 2),
    contentType: 'application/json',
  });

  // Now the product surface a user actually looks at: deep-link the search
  // box with the unique name so the assertion can't pass on unrelated
  // issues already in the queue, then confirm the row names both the
  // workload AND its namespace - "attributed to it", not just "something
  // matched text on the page".
  await page.goto(`/issues?q=${encodeURIComponent(WORKLOAD_NAME)}`);
  // Wait for the row rather than reloading in a loop. The page polls the fleet
  // endpoints itself, so a reload every couple of seconds does two harmful
  // things on a slower machine: it throws away an in-flight fetch before the
  // data lands (the page can never finish loading, so the row never appears),
  // and each reload spends several requests from the shared 30/min fleet
  // budget. A single navigation plus a patient wait tests the same thing.
  await expect
    .poll(() => page.getByText(`${NAMESPACE} / ${WORKLOAD_NAME}`).count(), {
      message: `Issues page never showed a row for ${NAMESPACE}/${WORKLOAD_NAME} even though the fleet issues API reported it`,
      timeout: 60_000,
      intervals: [1000, 2000, 3000, 5000],
    })
    .toBeGreaterThan(0);

  await testInfo.attach('issues-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('cross-cluster search finds the workload by name', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await useClusterWideNamespaceScope(page);

  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/fleet/search?q=${encodeURIComponent(WORKLOAD_NAME)}`);
        // Same shared 30/min/user fleet budget as above - back off rather
        // than reporting a rate limit as a broken search.
        if (res.status() === 429) return false;
        expect(res.status(), 'fleet search endpoint').toBe(200);
        const body = (await res.json()) as { hits: Array<{ namespace: string; name: string }> };
        return body.hits.some((h) => h.namespace === NAMESPACE && h.name === WORKLOAD_NAME);
      },
      {
        message: `/api/fleet/search never returned ${NAMESPACE}/${WORKLOAD_NAME} for q=${WORKLOAD_NAME} - the radar -> hub search fan-out is broken`,
        timeout: 30_000,
        intervals: [2000, 2000, 3000, 3000],
      },
    )
    .toBe(true);

  // The Search page (route /search) is the cross-cluster search surface a
  // user reaches from the hero search bar or the Fleet nav - confirm it
  // renders the same result, not just the API.
  await page.goto(`/search?search=${encodeURIComponent(WORKLOAD_NAME)}`);
  const table = page.getByRole('table');
  await expect(table).toBeVisible();

  const row = table.getByRole('row').filter({ hasText: WORKLOAD_NAME });
  await expect(row.first(), `no search result row for ${WORKLOAD_NAME}`).toBeVisible();
  await expect(row.first(), `search result for ${WORKLOAD_NAME} is not attributed to namespace ${NAMESPACE}`).toContainText(NAMESPACE);

  await testInfo.attach('search-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
