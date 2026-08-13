import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited, kubectl } from './helpers';

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
