import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  clusterId,
  gotoWhenNotRateLimited,
  kubectl,
  watchConsoleErrors,
} from './helpers';

// The Clusters table, held to the hub's own record and to the cluster itself.
//
// This is the page an operator uses to answer "is my fleet healthy", and every
// column on it is a claim: the cluster's name, its id, whether it is connected,
// which radar version is running in it, and when it was last heard from. Each
// is checkable - the first four against /api/clusters, the version against
// what is actually deployed in the cluster.
//
// Checking that the row renders would pass against a table showing the wrong
// version, or a cluster that has been silent for an hour reported as connected.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

type Cluster = {
  id: string;
  name: string;
  status: string;
  radar_version?: string;
  latest_radar_version?: string;
  upgrade_available?: boolean;
};

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

async function clustersFromApi(page: Page): Promise<Cluster[]> {
  return page
    .evaluate(async () => {
      const res = await fetch('/api/clusters');
      return res.ok ? await res.json() : [];
    })
    .catch(() => []);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('every column of the Clusters table matches the hub record for that cluster', { tag: '@sanity' }, async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/clusters');
  await expect(page.locator('tbody tr').first(), 'the Clusters page lists no clusters').toBeVisible({
    timeout: 60_000,
  });

  const clusters = await clustersFromApi(page);
  expect(clusters.length, 'the hub knows of no clusters, so the table cannot be checked').toBeGreaterThan(0);

  for (const cluster of clusters) {
    const row = page.locator('tbody tr').filter({ hasText: cluster.name }).first();
    const present = await expect(row)
      .toBeVisible({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    expect.soft(present, `the hub knows cluster "${cluster.name}" but the table does not list it`).toBe(true);
    if (!present) continue;

    const rowText = (await row.innerText()).replace(/\s+/g, ' ');

    expect
      .soft(rowText, `the row for ${cluster.name} does not show its id (${cluster.id})`)
      .toContain(cluster.id);
    expect
      .soft(
        rowText.toLowerCase(),
        `the hub records ${cluster.name} as "${cluster.status}" but the row says otherwise`,
      )
      .toContain(cluster.status.toLowerCase());

    if (cluster.radar_version) {
      expect
        .soft(
          rowText,
          `the hub records ${cluster.name} as running radar ${cluster.radar_version} but the row does not say so`,
        )
        .toContain(cluster.radar_version);
    }
  }

  await captureSurface(page, testInfo, 'clusters-table-truth');
});

test('the radar version on the Clusters page is the version actually deployed', async ({ page }) => {
  await gotoWhenNotRateLimited(page, '/clusters');
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });

  // What is really running, from the cluster rather than from the hub's record
  // of it - so a stale or mis-parsed version is caught rather than confirmed.
  const radarNamespace = process.env.RADAR_NS ?? 'radar';
  const image = kubectl(
    'get', 'deployment', '-n', radarNamespace,
    '-o', 'jsonpath={.items[0].spec.template.spec.containers[0].image}',
  );
  const tag = image.split(':').pop() ?? '';
  test.skip(!tag || tag === 'latest', `radar is deployed as "${image}", which carries no comparable version`);

  const clusters = await clustersFromApi(page);
  const reported = clusters[0]?.radar_version ?? '';

  // A dev build reports itself as "dev" while its image is tagged with a
  // branch or sha; that is not a mismatch worth failing on, and saying so is
  // more useful than pretending the comparison is always possible.
  test.skip(
    reported === 'dev' || tag === 'dev',
    `radar reports itself as "${reported}" from image "${image}" - a development build, so there is no released version to compare`,
  );

  expect
    .soft(
      reported,
      `the hub reports radar ${reported} for this cluster, but the deployment is running image ${image}`,
    )
    .toContain(tag.replace(/^v/, ''));
});

// The cluster overview page itself: /c/{cluster_id}.
//
// This is the page you land on when you click your cluster from the dashboard,
// and until now nothing tested it directly. It broke for six days in the
// published release and the suite only noticed sideways, through a test that
// follows every dashboard link - so the failure said "a link renders an error"
// rather than "the cluster page is down".
//
// What broke is worth encoding precisely. radar 1.11.0 removed
// `topologySummary` from /api/dashboard (skyhook-io/radar#1450); the hub's
// pinned copy of the UI still read `summary.nodeCount` off it, threw
// `Cannot read properties of undefined`, and an error boundary blanked the
// whole page. Every network call returned 200 - so a test that only checked
// responses, or only checked that something rendered, would have passed.
//
// Hence three separate checks: the page must not be an error boundary, it must
// carry facts from the real cluster, and the browser console must be clean. The
// last one is what would have caught that bug on the day it shipped.
test('the cluster overview page renders this cluster, without a client error', async ({ page }, testInfo) => {
  const consoleErrors = watchConsoleErrors(page);

  await gotoWhenNotRateLimited(page, `/c/${clusterId}`);
  await expect
    .poll(async () => (await bodyText(page)).length, {
      message: `/c/${clusterId} never rendered anything`,
      timeout: 90_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeGreaterThan(300);

  // 1. Not an error boundary. This is the exact symptom of the 1.11.0 break.
  await expect
    .soft(
      page.getByText(/something went wrong|unexpected error/i).first(),
      `/c/${clusterId} rendered an error boundary - the page an operator reaches by clicking their cluster is down`,
    )
    .toBeHidden({ timeout: 15_000 });

  // 2. It is about THIS cluster, and carries facts the cluster really has.
  const text = await bodyText(page);
  const nodes = kubectl('get', 'nodes', '--no-headers', '-o', 'name').split('\n').filter(Boolean).length;
  const clusters = await clustersFromApi(page);
  const name = clusters.find((c) => c.id === clusterId)?.name;

  if (name) {
    expect.soft(text, `/c/${clusterId} does not name the cluster it is about (${name})`).toContain(name);
  }
  expect
    .soft(text, `/c/${clusterId} does not report the ${nodes} node(s) this cluster has`)
    .toMatch(new RegExp(`\\b${nodes}\\b`));

  // 3. A clean console. The page can look complete while a card has thrown,
  // and a thrown card is what took the whole page down last time.
  const errors = consoleErrors().filter((e) => !/429|Too Many Requests|favicon/i.test(e));
  testInfo.annotations.push({
    type: 'console',
    description: errors.length ? errors.slice(0, 3).join(' | ') : 'clean',
  });
  expect
    .soft(
      errors,
      `/c/${clusterId} logged browser errors while rendering - a card that throws here takes the page with it`,
    )
    .toEqual([]);

  await captureSurface(page, testInfo, 'cluster-overview');
});
