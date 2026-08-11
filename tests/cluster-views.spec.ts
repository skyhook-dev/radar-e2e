import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl } from './helpers';

// Clusters list + the cluster-scoped views that are radar's own UI embedded
// by the hub and proxied over the tunnel: Topology, Traffic, Capacity, Cost.
// These four break as a group when the proxy/tunnel breaks and individually
// when a view itself breaks, so each gets its own real-data assertion rather
// than a shared "page didn't 404" check.
//
// This is a single-node kind cluster with a handful of workloads, and
// Prometheus is deliberately not installed (radar logs "no Prometheus
// service found"). That shapes what "real" looks like per view:
//   - Topology: full resource graph, independent of Prometheus - asserted
//     against live kubectl counts.
//   - Capacity: node/allocatable inventory comes from the K8s API (node
//     status), not Prometheus - asserted against radar's own /api/capacity.
//   - Traffic: no CNI-based flow-capture tool (Caretta/Hubble/Istio) is
//     installed either, so there is no live flow graph to assert on. What's
//     real here is the platform-detection screen; asserted against radar's
//     own /api/traffic/sources so it isn't a hardcoded guess.
//   - Cost: genuinely empty by design (no Prometheus/OpenCost). The
//     meaningful assertion is that the view reaches its terminal "Prometheus
//     not found" state instead of hanging on a spinner forever - proving the
//     full proxy chain works even for a "no data" outcome.
//
// Not covered: any view's actual metrics-backed content (traffic flow
// volumes, cost breakdowns, usage-based capacity numbers) - none of it can
// exist without Prometheus/a CNI capture tool, so asserting on it here would
// be asserting against a fixture, not this environment's reality.

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through e2e/browser/run.sh');
});

// Count live objects of a kind in a namespace. Used against `radar` and
// `radar-hub` only - the two namespaces every agent on this shared harness is
// forbidden to modify - so the counts stay true for the life of the test even
// while other agents create/delete their own scratch namespaces concurrently.
function countKind(namespace: string, kind: string): number {
  const out = kubectl('-n', namespace, 'get', kind, '-o', 'name');
  return out ? out.split('\n').filter(Boolean).length : 0;
}

// Mirrors k8s-ui's pluralize(): singular at n===1, else regular +s. Safe for
// the kind names used below (Pod/Service/Deployment/StatefulSet) - none of
// them hit englishPlural's irregular branches (s/x/ch/sh, consonant+y).
function pluralPhrase(count: number, singular: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${singular}s`;
}

// The namespace scope shown on every cluster-scoped view is a per-admin-
// account preference stored server-side (radar-hub-web's own docs: "the
// in-app namespace switcher POSTs to /api/cluster/namespace, which the
// server stores as a per-user preference"). Every agent on this harness
// signs in as the same break-glass admin, so whichever namespace another
// agent last picked leaks into this page load. Reset to "All namespaces" -
// the same click a real user would make - before trusting what the graph
// shows; otherwise a concurrent agent's scoped view reads as "topology is
// broken" when it's actually just filtered.
async function ensureAllNamespaces(page: Page) {
  const trigger = page.getByRole('button', { name: 'Switch active namespaces' });
  await expect(trigger).toBeVisible();
  if ((await trigger.innerText()).includes('All namespaces')) return;
  await trigger.click();
  await page.getByRole('button', { name: 'Clear namespace selection' }).click();
  await expect(trigger, 'could not reset the namespace filter to All namespaces').toContainText(
    'All namespaces',
  );
}

// -- Capacity formatting, mirrored from @skyhook-io/k8s-ui/utils/format so the
// test can compare radar's own /api/capacity response against what the page
// renders, without hardcoding node numbers that are only true on this laptop
// today.

function parseCPUToCores(cpuString: string): number {
  const s = cpuString.trim();
  if (s.endsWith('n')) return parseInt(s.slice(0, -1), 10) / 1_000_000_000;
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) / 1000;
  return parseFloat(s);
}

function formatCoresAllocatable(cpuString: string): string {
  const cores = parseCPUToCores(cpuString);
  const rounded = Math.round(cores * 10) / 10;
  const formatted = rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${formatted} cores allocatable`;
}

function parseMemoryToBytes(memString: string): number {
  const match = memString.trim().match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]*)$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const binary: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const decimal: Record<string, number> = { k: 1000, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 };
  const suffix = match[2];
  if (suffix in binary) return num * binary[suffix];
  if (suffix in decimal) return num * decimal[suffix];
  return num;
}

function formatMemoryAllocatable(memString: string): string {
  const bytes = parseMemoryToBytes(memString);
  if (bytes >= 1024 ** 3) {
    const gib = bytes / 1024 ** 3;
    return `${gib >= 10 ? gib.toFixed(1) : gib.toFixed(2)} GiB allocatable`;
  }
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB allocatable`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB allocatable`;
  return `${bytes} B allocatable`;
}

// Fails loudly (rather than silently passing) when a view logs a console
// error while still appearing to render - the kind of bug a screenshot alone
// won't catch.
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// 429s are expected noise on this shared hub - other agents are hitting the
// same instance concurrently and its break-glass-login limiter also throttles
// background API polling. That is environment contention, not a rendering
// bug in the view under test, so it is excluded from the failing assertion
// (it is still attached in full for every test, 429s included).
function meaningfulErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes('429'));
}

test.describe('Clusters page', () => {
  test('shows the connected cluster with a healthy status and its real radar version', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await assertClusterConnected(page);

    // Ground truth is the hub's own API, not a hardcoded version string -
    // the harness rebuilds radar from source each run, so the version drifts.
    const res = await page.request.get('/api/clusters');
    expect(res.status(), 'clusters endpoint').toBe(200);
    const cluster = (await res.json()).find((c: { id: string }) => c.id === clusterId);
    expect(cluster, `cluster ${clusterId} missing from /api/clusters`).toBeTruthy();

    await page.goto('/clusters');
    const table = page.getByRole('table').first();
    await expect(table).toBeVisible();
    const row = table.getByRole('row').filter({ hasText: clusterId });
    await expect(row.first(), `no Clusters row for ${clusterId}`).toBeVisible();
    await expect(row.first(), 'status pill should read Connected').toContainText('Connected');
    await expect(
      row.first(),
      `version pill should show the radar_version (${cluster.radar_version}) the API reports`,
    ).toContainText(cluster.radar_version);

    await testInfo.attach('clusters-page.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
});

test.describe('cluster-scoped views (radar embedded via the tunnel)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await assertClusterConnected(page);
  });

  test('Topology renders the live resource graph, matching object counts radar itself reports', async ({
    page,
  }, testInfo) => {
    const errors = trackConsoleErrors(page);

    // radar-hub is the richer of the two protected namespaces (multiple
    // pods/services/deployments/a statefulset), so a mismatch here is a
    // strong signal the graph isn't showing real data.
    const radarHub = {
      pods: countKind('radar-hub', 'pods'),
      services: countKind('radar-hub', 'services'),
      deployments: countKind('radar-hub', 'deployments'),
      statefulsets: countKind('radar-hub', 'statefulsets'),
    };
    expect(radarHub.pods, 'radar-hub should have pods - the harness installs it').toBeGreaterThan(0);

    await page.goto(`/c/${clusterId}/topology`);
    await ensureAllNamespaces(page);

    const group = page.getByTestId('rf__node-group-namespace-radar-hub');
    await expect(
      group,
      'no topology group for the radar-hub namespace - the graph is not showing real cluster data',
    ).toBeVisible();
    await expect(group, 'Pod count on the radar-hub group does not match kubectl').toContainText(
      pluralPhrase(radarHub.pods, 'Pod'),
    );
    await expect(group, 'Service count on the radar-hub group does not match kubectl').toContainText(
      pluralPhrase(radarHub.services, 'Service'),
    );
    await expect(group, 'Deployment count on the radar-hub group does not match kubectl').toContainText(
      pluralPhrase(radarHub.deployments, 'Deployment'),
    );
    await expect(group, 'StatefulSet count on the radar-hub group does not match kubectl').toContainText(
      pluralPhrase(radarHub.statefulsets, 'StatefulSet'),
    );

    await testInfo.attach('topology-page.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await testInfo.attach('topology-console-errors.json', {
      body: JSON.stringify(errors, null, 2),
      contentType: 'application/json',
    });
    expect(
      meaningfulErrors(errors),
      `Topology logged console errors while rendering: ${errors.join('; ')}`,
    ).toEqual([]);
  });

  test('Capacity shows the real node inventory radar reports over the API, not a Karpenter-only shell', async ({
    page,
  }, testInfo) => {
    const errors = trackConsoleErrors(page);

    await page.goto(`/c/${clusterId}/capacity`);

    const res = await page.request.get(`/c/${clusterId}/api/capacity`);
    expect(res.status(), 'capacity API').toBe(200);
    const data = await res.json();
    const allocatable = data.summary?.clusterScheduling?.allocatable?.resources;
    expect(allocatable?.cpu, 'capacity API reported no allocatable CPU - nothing to verify the page against').toBeTruthy();

    // Node count/allocatable come from the K8s API (node status), which does
    // not depend on Prometheus and is stable on this single-node cluster
    // regardless of what pods other agents schedule concurrently. Scheduled
    // *requests* are deliberately NOT asserted - those fluctuate as other
    // agents' scratch namespaces come and go.
    await expect(page.getByText('Capacity overview')).toBeVisible();
    const nodesTile = page.getByText('Nodes', { exact: true }).locator('xpath=../..');
    await expect(nodesTile, 'Nodes tile does not report the real node count').toContainText(
      String(data.summary.nodeCount),
    );

    const cpuText = formatCoresAllocatable(allocatable.cpu);
    const memText = formatMemoryAllocatable(allocatable.memory);
    await expect(
      page.locator('body'),
      `CPU scheduling bar should read "${cpuText}" (from radar's own /api/capacity)`,
    ).toContainText(cpuText);
    await expect(
      page.locator('body'),
      `Memory scheduling bar should read "${memText}" (from radar's own /api/capacity)`,
    ).toContainText(memText);

    await testInfo.attach('capacity-page.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await testInfo.attach('capacity-console-errors.json', {
      body: JSON.stringify(errors, null, 2),
      contentType: 'application/json',
    });
    expect(
      meaningfulErrors(errors),
      `Capacity logged console errors while rendering: ${errors.join('; ')}`,
    ).toEqual([]);
  });

  test('Traffic correctly detects this cluster has no flow-capture tool, instead of a blank or errored view', async ({
    page,
  }, testInfo) => {
    const errors = trackConsoleErrors(page);

    // No CNI-based flow tool (Caretta/Hubble/Istio) is installed on this kind
    // cluster, so there is no live traffic graph to assert against - that
    // mirrors the Prometheus caveat, just for traffic tooling. What IS real
    // and worth proving: the setup screen reflects radar's own live platform
    // detection rather than static copy.
    const res = await page.request.get(`/c/${clusterId}/api/traffic/sources`);
    expect(res.status(), 'traffic sources API').toBe(200);
    const sources = await res.json();
    expect(sources.cluster?.platform, 'traffic detection did not report a platform').toBeTruthy();

    await page.goto(`/c/${clusterId}/traffic`);

    await expect(
      page.getByText(`Platform: ${sources.cluster.platform}`),
      'Traffic view platform label does not match radar\'s own detection API',
    ).toBeVisible();
    if (sources.recommended?.name) {
      // exact: false substring text like "caretta" also matches the reason
      // copy and the "Install caretta with Helm" button, so pin to the
      // recommendation's own name chip.
      await expect(
        page.getByText(sources.recommended.name, { exact: true }),
        `Traffic view should recommend "${sources.recommended.name}" per radar's own detection API`,
      ).toBeVisible();
    }

    await testInfo.attach('traffic-page.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await testInfo.attach('traffic-console-errors.json', {
      body: JSON.stringify(errors, null, 2),
      contentType: 'application/json',
    });
    expect(
      meaningfulErrors(errors),
      `Traffic logged console errors while rendering: ${errors.join('; ')}`,
    ).toEqual([]);
  });

  test('Cost correctly reports no Prometheus/OpenCost source instead of hanging or erroring', async ({
    page,
  }, testInfo) => {
    const errors = trackConsoleErrors(page);

    const summaryRes = await page.request.get(`/c/${clusterId}/api/opencost/summary`);
    expect(summaryRes.status(), 'opencost summary API').toBe(200);
    const summary = await summaryRes.json();
    test.skip(
      !(summary.available === false && summary.reason === 'no_prometheus'),
      'this environment has Prometheus/OpenCost available - the no-data assertion below does not apply',
    );

    await page.goto(`/c/${clusterId}/cost`);

    // The product gives itself a 30s discovery grace window
    // (COST_DISCOVERY_GRACE_MS) before declaring Prometheus definitively
    // missing - poll through it rather than asserting immediately, which
    // would only ever catch the transient "still looking" spinner.
    await expect
      .poll(
        async () =>
          page.getByText('Prometheus not found — OpenCost requires Prometheus or VictoriaMetrics').isVisible(),
        {
          message:
            'Cost view never reached its terminal "Prometheus not found" state - it either hung on the spinner forever or the proxy/product path is broken',
          timeout: 45_000,
          intervals: [2000, 3000, 5000],
        },
      )
      .toBe(true);

    await testInfo.attach('cost-page.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await testInfo.attach('cost-console-errors.json', {
      body: JSON.stringify(errors, null, 2),
      contentType: 'application/json',
    });
    expect(
      meaningfulErrors(errors),
      `Cost logged console errors while rendering: ${errors.join('; ')}`,
    ).toEqual([]);
  });
});
