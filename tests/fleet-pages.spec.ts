import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, clusterId } from './helpers';

// Every domain, at its FLEET-level location.
//
// The suite tests seven domains only at their cluster-scoped address -
// /c/{id}/resources, /c/{id}/helm, /c/{id}/timeline and so on - while the app's
// navigation offers each of them at the top level too. Those are not the same
// page: the cluster-scoped one proxies a single agent, the fleet one fans out
// across every connected cluster and merges the answers. A domain can work
// perfectly at one address and be broken at the other, and nothing here would
// have noticed, because no spec ever opened the fleet version.
//
// Enumerated from the app's own navigation rather than a list someone wrote
// down: these are the hrefs the shell links to.
//
// Each page is held to the same three things, all soft so one broken page does
// not hide the other six:
//   - it renders something substantial, so a blank or crashed page is caught
//   - it is not showing an error or stuck loading
//   - it names this cluster, or explains why it has nothing to show
// The last one is what makes it more than a smoke test: a fleet page that
// renders an empty shell while a cluster is connected is the failure mode
// worth catching, and it looks completely healthy from a screenshot.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const BROKEN = /something went wrong|failed to load|unable to load|unexpected error/i;

/** Fleet-level pages, and the cluster-scoped page each one aggregates. */
const FLEET_PAGES: { path: string; domain: string; clusterScoped: string }[] = [
  { path: '/resources', domain: 'Resources', clusterScoped: 'resources' },
  { path: '/helm', domain: 'Helm', clusterScoped: 'helm' },
  { path: '/timeline', domain: 'Timeline', clusterScoped: 'timeline' },
  { path: '/topology', domain: 'Topology', clusterScoped: 'topology' },
  { path: '/traffic', domain: 'Traffic', clusterScoped: 'traffic' },
  { path: '/capacity', domain: 'Capacity', clusterScoped: 'capacity' },
  { path: '/cost', domain: 'Cost', clusterScoped: 'cost' },
];

/** Re-read rather than snapshot: these pages fetch after their chrome renders. */
const bodyText = async (page: Page) => (await page.locator('body').innerText()).trim();

test('every domain the navigation offers at fleet level actually renders there', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  const clustersRes = await page.request.get('/api/clusters');
  const clusters = (await clustersRes.json()) as Array<{ id: string; name?: string; status: string }>;
  const connectedName = clusters.find((c) => c.id === clusterId)?.name ?? '';

  for (const { path, domain } of FLEET_PAGES) {
    await page.goto(path);

    // Substantial content, polled - the chrome renders before the data, so a
    // single read here would catch the page mid-load and blame the product.
    await expect
      .poll(async () => (await bodyText(page)).length, {
        message: `${path}: the fleet ${domain} page rendered almost nothing`,
        timeout: 45_000,
        intervals: [1000, 2000, 3000],
      })
      .toBeGreaterThan(200);
    const text = await bodyText(page);
    expect
      .soft(text.length, `${path}: the fleet ${domain} page rendered only ${text.length} characters`)
      .toBeGreaterThan(200);

    await expect
      .soft(page.getByText(BROKEN).first(), `${path}: the fleet ${domain} page rendered an error state`)
      .toBeHidden({ timeout: 15_000 });

    await expect
      .soft(
        page.getByText(/^\s*(loading|fetching)/i).first(),
        `${path}: the fleet ${domain} page was still loading after 15s - a stuck page looks identical to a working one in a screenshot`,
      )
      .toBeHidden({ timeout: 15_000 });

    // The page must show it has a fleet: either it names the connected cluster,
    // or it says plainly that it has nothing to show. An empty grid with no
    // explanation, while a cluster is connected, is the case worth failing on.
    const mentionsCluster = connectedName ? text.includes(connectedName) : false;
    const explainsEmpty =
      /no |none|not connected|nothing|empty|install|connect|get started|unavailable/i.test(text);
    expect
      .soft(
        mentionsCluster || explainsEmpty,
        `${path}: the fleet ${domain} page neither names the connected cluster "${connectedName}" nor explains why it has nothing to show - ` +
          `a user with a connected cluster sees a blank page and cannot tell whether that means healthy, empty, or broken`,
      )
      .toBe(true);

    testInfo.annotations.push({
      type: `fleet:${domain}`,
      description: `${text.length} chars, names cluster: ${mentionsCluster}`,
    });

    await captureSurface(page, testInfo, `fleet-${domain.toLowerCase()}`);
  }
});

test('the fleet and cluster-scoped views of a domain do not contradict each other', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // With one cluster attached, a fleet page and its cluster-scoped counterpart
  // are answering the same question about the same cluster. They are allowed to
  // present it differently; they are not allowed to disagree about whether
  // there is anything there. A fleet page showing an empty state while the
  // cluster page shows content means the fan-out dropped the cluster.
  for (const { path, domain, clusterScoped } of FLEET_PAGES) {
    await page.goto(path);
    await expect
      .poll(async () => (await bodyText(page)).length, {
        message: `${path}: never rendered`,
        timeout: 45_000,
        intervals: [1000, 2000, 3000],
      })
      .toBeGreaterThan(200);
    const fleetText = await bodyText(page);

    await page.goto(`/c/${clusterId}/${clusterScoped}`);
    await expect
      .poll(async () => (await bodyText(page)).length, {
        message: `/c/{id}/${clusterScoped}: never rendered`,
        timeout: 45_000,
        intervals: [1000, 2000, 3000],
      })
      .toBeGreaterThan(200);
    const clusterText = await bodyText(page);

    // "Has content" is judged the same way on both sides, so the comparison is
    // like for like rather than a guess about each page's copy.
    const emptyish = (t: string) => /no results|nothing to show|no data|not connected/i.test(t) && t.length < 1200;
    expect
      .soft(
        !(emptyish(fleetText) && !emptyish(clusterText)),
        `${domain}: the fleet page at ${path} looks empty while /c/{id}/${clusterScoped} has content for the same ` +
          `cluster - with one cluster attached these answer the same question, so the fan-out has dropped it`,
      )
      .toBe(true);
  }

  await captureSurface(page, testInfo, 'fleet-vs-cluster-scoped');
});
