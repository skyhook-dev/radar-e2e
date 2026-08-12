import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertClusterConnected, clusterId, kubectl, installedHelmReleases, captureSurface } from './helpers';

// Applications + Packages: the two fleet-wide (cross-cluster) pivots.
//
//   Applications answers "what deployable/owned software units run here" -
//   radar OSS groups a cluster's workloads into one row per logical app,
//   anchored on the pkg/subject Tier-2 label overlay (app.kubernetes.io/name
//   etc.) or, absent any signal, the raw structural root. Hub fans
//   GET /api/applications out to every connected cluster and joins rows by
//   overlay key so the frontend can lay a fleet out across clusters
//   (internal/server/fleet_applications.go).
//
//   Packages answers "what software is installed" - a chart x cluster
//   matrix built by pivoting radar OSS's /api/packages Helm/Labels/CRD/
//   ArgoCD/Flux aggregation by chart name (internal/server/fleet_packages.go).
//   tests/helm.spec.ts already proves the per-cluster Helm page reads real
//   release data; this spec only exercises what Packages does differently -
//   the chart-name pivot (radar OSS splits "radar-1.7.1" into chart="radar" +
//   version="1.7.1", distinct from Helm's raw "chart" field) and the
//   cluster-keyed cell map that page is built around.
//
// Both endpoints share one gotcha with fleet Issues/Search (see
// KNOWN-ISSUES.md #1): radar's handleApplications/handlePackages resolve an
// unscoped request through parseNamespacesForUser, which falls back to
// whatever this shared admin session's single-cluster namespace switcher last
// picked. Reset it to "All namespaces" before every read, same as
// tests/issues.spec.ts and tests/resources.spec.ts do.

const NAMESPACE = 'e2e-apps';
const APP_NAME = `e2e-app-${Date.now()}`;
const APP_VERSION = 'v1.4.2';
const IMAGE = 'registry.k8s.io/pause:3.9';
const REPLICAS = 2;

let createdAt = 0;

function ensureNamespace(): void {
  const existing = kubectl('get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'jsonpath={.metadata.name}');
  if (existing !== NAMESPACE) kubectl('create', 'namespace', NAMESPACE);
}

// A plain Deployment carrying app.kubernetes.io/name (+ /version) on the
// Deployment object itself - radar's collectAppWorkloads reads the
// Deployment's OWN labels (d.Labels), not the pod template's. That label is
// what pkg/subject.ResolveOverlay keys the app's Tier-8 grouping signal on
// (Key = "<ns>/app/<name>"), so the app row's Name comes out as this exact
// label value and AppVersion as the /version label - not guessed from the
// object name.
function applyAppDeployment(): void {
  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${APP_NAME}
    app.kubernetes.io/version: ${APP_VERSION}
    e2e-applications-packages-spec: "true"
spec:
  replicas: ${REPLICAS}
  selector:
    matchLabels:
      app: ${APP_NAME}
  template:
    metadata:
      labels:
        app: ${APP_NAME}
    spec:
      containers:
        - name: main
          image: ${IMAGE}
          resources:
            requests:
              cpu: 5m
              memory: 8Mi
            limits:
              cpu: 20m
              memory: 32Mi
`;
  const file = path.join(os.tmpdir(), `${APP_NAME}.yaml`);
  fs.writeFileSync(file, manifest);
  try {
    kubectl('apply', '-f', file);
  } finally {
    fs.rmSync(file, { force: true });
  }
  kubectl('rollout', 'status', `deployment/${APP_NAME}`, '-n', NAMESPACE, '--timeout=60s');
}

/**
 * Same shared-state hazard tests/issues.spec.ts and tests/resources.spec.ts
 * document: radar's per-cluster handlers fall back to whatever this session's
 * namespace switcher last had picked when a fleet request carries no explicit
 * namespace filter, and that pick is server-side, per-login state shared by
 * every concurrent agent using this one break-glass admin account. Reset to
 * "All namespaces" before reading either fleet endpoint below.
 */
async function useClusterWideNamespaceScope(page: Page): Promise<void> {
  const res = await page.request.post(`/c/${clusterId}/api/cluster/namespace`, {
    headers: { 'X-Hub-Auth': '1' },
    data: { namespaces: [] },
  });
  expect(res.status(), 'reset the shared admin namespace-switcher scope to All namespaces').toBe(200);
}

type AppWorkload = {
  kind: string;
  namespace: string;
  name: string;
  workload_class?: string;
  image?: string;
  version?: string;
  appVersion?: string;
  health: string;
  ready: number;
  desired: number;
  restarts: number;
};

type AppCell = {
  health: string;
  workload_class?: string;
  versions?: string[];
  appVersion?: string;
  workloads?: AppWorkload[];
};

type AppFleetRow = {
  key: string;
  name: string;
  namespace?: string;
  category?: string;
  workload_class?: string;
  appVersion?: string;
  cells: Record<string, AppCell>;
  cluster_count: number;
};

type FleetApplicationsResponse = {
  applications: AppFleetRow[];
  clusters: Array<{ cluster_id: string; cluster_name: string; connected: boolean }>;
};

/** Polls a fleet endpoint, treating 429 as "ask again" per the shared 30/min/user budget. */
async function pollFleetJSON<T>(
  page: Page,
  path: string,
  predicate: (body: T) => boolean,
  message: string,
  timeout = 90_000,
): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(path);
        if (res.status() === 429) return false;
        expect(res.status(), `${path} endpoint`).toBe(200);
        last = (await res.json()) as T;
        return predicate(last);
      },
      { message, timeout, intervals: [3000, 3000, 5000, 5000, 8000, 8000] },
    )
    .toBe(true);
  return last as T;
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
  ensureNamespace();
  createdAt = Date.now();
  applyAppDeployment();
});

test.afterAll(() => {
  try {
    kubectl('-n', NAMESPACE, 'delete', 'deployment', APP_NAME, '--ignore-not-found', '--wait=false');
  } catch {
    // best-effort - don't let cleanup failure mask a real test failure
  }
});

test.describe('Applications', () => {
  test('a workload identified by app.kubernetes.io/name is listed with its real attributes', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await assertClusterConnected(page);
    await useClusterWideNamespaceScope(page);

    let detectedAfterMs = 0;
    const data = await pollFleetJSON<FleetApplicationsResponse>(
      page,
      '/api/fleet/applications',
      (body) => {
        const found = body.applications.some((a) => a.name === APP_NAME);
        if (found) detectedAfterMs = Date.now() - createdAt;
        return found;
      },
      `no application row named ${APP_NAME} ever appeared on /api/fleet/applications - radar's app grouping never picked up the app.kubernetes.io/name label, or the applications fan-out is broken (radar's own /api/applications caches for 60s, so this can legitimately take a while)`,
    );

    const row = data.applications.find((a) => a.name === APP_NAME)!;
    const cell = row.cells[clusterId];
    expect(cell, `application ${APP_NAME} has no cell for cluster ${clusterId} - the fleet cell map isn't keyed by this cluster`).toBeTruthy();

    // Grouping: a plain Deployment with no addon-shaped labels/chart/image
    // must classify as an app, not add-on platform inventory.
    expect(row.category, `${APP_NAME} classified as "${row.category}" - expected "app" (no addon-shaped label/chart/image was set)`).toBe('app');
    // No Service/Ingress points at it, so radar's classifyWorkload calls it a worker, not a service.
    expect(cell.workload_class, `${APP_NAME} workload_class should be "worker" (no Service/Ingress attached)`).toBe('worker');
    // AppVersion comes from the app.kubernetes.io/version label we set - not guessed.
    expect(cell.appVersion, `${APP_NAME} cell.appVersion should echo the app.kubernetes.io/version label`).toBe(APP_VERSION);
    expect(cell.versions, `${APP_NAME} cell.versions should carry the running image tag`).toContain('3.9');

    const workload = (cell.workloads ?? []).find((w) => w.kind === 'Deployment' && w.name === APP_NAME);
    expect(workload, `${APP_NAME} cell has no Deployment workload named ${APP_NAME}`).toBeTruthy();
    expect(workload!.namespace, 'workload namespace should be e2e-apps').toBe(NAMESPACE);
    expect(workload!.image, 'workload image should be the pause image we deployed').toBe(IMAGE);
    expect(workload!.ready, `${REPLICAS} replicas were rolled out - ready should match`).toBe(REPLICAS);
    expect(workload!.desired, `desired replicas should be ${REPLICAS}`).toBe(REPLICAS);
    expect(workload!.health, `all ${REPLICAS} replicas are ready - health should be healthy`).toBe('healthy');

    await testInfo.attach('applications-api-detection.json', {
      body: JSON.stringify({ name: APP_NAME, namespace: NAMESPACE, detectedAfterMs, row }, null, 2),
      contentType: 'application/json',
    });

    // Now the surface a user looks at. Deep-link isn't supported (the search
    // param lives in ApplicationsView's own filter state, not the URL), so
    // navigate to the list and filter through its search box.
    await page.goto('/applications');
    // Scoped to the list's own SearchBox, not the top-bar global command
    // palette search (which shares the generic "search" wording).
    const searchBox = page.getByPlaceholder('Search... (press /)');
    await expect(searchBox).toBeVisible();
    await searchBox.fill(APP_NAME);

    const table = page.getByRole('table').first();
    await expect(table).toBeVisible();
    const uiRow = table.getByRole('row').filter({ hasText: APP_NAME });
    await expect(uiRow.first(), `no Applications-page row for ${APP_NAME} even though the fleet API reports it`).toBeVisible();
    // Runtime column renders "ready/desired" verbatim.
    await expect(uiRow.first(), `row doesn't show ${REPLICAS}/${REPLICAS} ready replicas`).toContainText(`${REPLICAS}/${REPLICAS}`);
    // Version column (fleet variant, single version) renders the bare image tag.
    await expect(uiRow.first(), 'row does not show the running image tag 3.9').toContainText('3.9');
    // Workloads column summarizes kind counts.
    await expect(uiRow.first(), 'row does not summarize its one Deployment workload').toContainText('Deployment');

    await captureSurface(page, testInfo, 'applications-list-with-labelled-app');
  });
});

// --- Packages -------------------------------------------------------------

type PackageCell = {
  version?: string;
  health: string;
  sources: string[];
  release_name?: string;
  namespace?: string;
};

type PackageRow = {
  chart: string;
  cells: Record<string, PackageCell>;
  cluster_count: number;
};

type FleetPackagesResponse = {
  packages: PackageRow[];
  clusters: Array<{ cluster_id: string; cluster_name: string; connected: boolean; sources_used?: string[] }>;
};

/**
 * Mirrors radar OSS's pkg/packages.splitChart (aggregate.go): the base chart
 * name is everything before the LAST hyphen whose following character starts
 * a semver-ish version ("radar-hub-1.3.1" -> "radar-hub" + "1.3.1"). This is
 * exactly what turns Helm's raw "<chart>-<version>" string into the Packages
 * page's chart-name row key + separate version cell - the thing this spec
 * exists to prove, so it's re-derived here rather than hardcoded per release.
 */
function splitHelmChart(s: string): { name: string; version: string } {
  if (!s) return { name: '', version: '' };
  for (let i = s.length - 1; i >= 1; i--) {
    if (s[i - 1] !== '-') continue;
    const rest = s.slice(i);
    if (!rest) continue;
    const c = rest[0];
    if (c >= '0' && c <= '9') return { name: s.slice(0, i - 1), version: rest };
    if (c === 'v' && rest.length > 1 && rest[1] >= '0' && rest[1] <= '9') {
      return { name: s.slice(0, i - 1), version: rest };
    }
  }
  return { name: s, version: '' };
}

test.describe('Packages', () => {
  test('the fleet pivot reflects the installed Helm releases, keyed by chart and cluster', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await assertClusterConnected(page);
    await useClusterWideNamespaceScope(page);

    // Truth from helm, not a fixture. The harness guarantees `radar` (ns
    // radar) and `radar-hub` (ns radar-hub); read whatever's actually
    // installed so the assertions track reality if that ever changes.
    const releases = installedHelmReleases();
    expect(releases.length, 'no Helm releases in the cluster - the harness installs at least radar + radar-hub').toBeGreaterThan(0);
    // Kept as a distinct `split` field (not spread into the release) so the
    // Helm release's own `name` is never shadowed by the chart's base name -
    // they read the same for radar/radar-hub today, but conflating them would
    // silently stop testing the right thing the moment that isn't true.
    const expected = releases.map((r) => ({ release: r, split: splitHelmChart(r.chart) }));

    const data = await pollFleetJSON<FleetPackagesResponse>(
      page,
      '/api/fleet/packages',
      (body) => expected.every(({ release, split }) => {
        const row = body.packages.find((p) => p.chart === split.name);
        return !!row && !!row.cells[clusterId] && row.cells[clusterId].release_name === release.name;
      }),
      `/api/fleet/packages never reflected all ${expected.length} installed Helm releases (${expected.map((e) => e.release.name).join(', ')})`,
    );

    for (const { release, split } of expected) {
      const row = data.packages.find((p) => p.chart === split.name);
      expect(row, `no package row for chart "${split.name}" - expected the Helm chart "${release.chart}" split into base name "${split.name}"`).toBeTruthy();
      // Proves this is a real pivot, not the raw Helm "chart" field passed
      // through: the row key is the split base name, never the full
      // "<chart>-<version>" string tests/helm.spec.ts matches on.
      expect(row!.chart, 'the Packages row key must be the base chart name, distinct from the raw Helm chart-version string').not.toBe(release.chart);

      const cell = row!.cells[clusterId];
      expect(cell, `package "${split.name}" has no cell for cluster ${clusterId} - the cross-cluster cell map isn't keyed by this cluster`).toBeTruthy();
      expect(cell.version, `package "${split.name}" cell should carry the Helm chart version ${split.version}`).toBe(split.version);
      expect(cell.namespace, `package "${split.name}" cell namespace should be ${release.namespace}`).toBe(release.namespace);
      expect(cell.release_name, `package "${split.name}" cell should name the Helm release "${release.name}"`).toBe(release.name);
      expect(cell.sources, `package "${split.name}" should be sourced via Helm ("H")`).toContain('H');
      // Both harness releases are healthy, running deployments - the page must
      // not flatten that into "unknown" the way a CRD-only row legitimately would.
      expect(cell.health, `package "${split.name}" should report health "healthy" from its backing workloads`).toBe('healthy');
    }

    await testInfo.attach('packages-api-pivot.json', {
      body: JSON.stringify({ expected, packages: data.packages.filter((p) => expected.some((e) => e.split.name === p.chart)) }, null, 2),
      contentType: 'application/json',
    });

    // The page itself. Route is top-level /packages (no /fleet prefix, no
    // per-cluster :id - it's a fleet surface, unlike tests/helm.spec.ts's
    // /c/{id}/helm).
    await page.goto('/packages');
    const table = page.getByRole('table').first();
    await expect(table).toBeVisible();

    for (const { release, split } of expected) {
      // Exact text match on the chart-name cell: "radar" must not
      // accidentally match the "radar-hub" row too (a substring filter would).
      const row = table.locator('tbody tr').filter({ has: page.getByText(split.name, { exact: true }) });
      await expect(row.first(), `no Packages-page row for chart "${split.name}"`).toBeVisible();
      await expect(row.first(), `row for "${split.name}" doesn't show version ${split.version}`).toContainText(split.version);
      // The row's chart cell must show only the base name, not the raw
      // "<chart>-<version>" Helm string - the visible proof of the pivot.
      await expect(row.first().locator('td').first(), `chart cell for "${split.name}" leaked the raw Helm chart-version string`).not.toContainText(release.chart);
    }

    // Cross-cluster affordances that only make sense with 2+ clusters are
    // absent in this single-cluster harness - "Show drift only" checkbox and
    // the multi-cluster CoverageStrip both gate on clusters.length >= 2. That
    // is the honest single-cluster picture, not a broken page: assert their
    // absence rather than silently skipping the question.
    await expect(page.getByText('Show drift only'), 'drift toggle should be hidden with only one connected cluster').toHaveCount(0);

    // Detection coverage footer is always rendered and names the source path
    // that worked for this cluster - unlike the CoverageStrip above, it isn't
    // gated on cluster count, so it's the one coverage signal this
    // single-cluster harness can actually exercise.
    await expect(page.getByText('Detection coverage', { exact: true }), 'Detection coverage footer missing').toBeVisible();
    await expect(page.getByText(/via Helm/), 'Detection coverage footer should show Helm as a working detection source for this cluster').toBeVisible();

    await captureSurface(page, testInfo, 'packages-pivot-by-chart');
  });
});
