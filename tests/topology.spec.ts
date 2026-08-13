import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  gotoWhenNotRateLimited,
  kubectl,
  waitForFleetReporting,
} from './helpers';

// Topology, held to the cluster it claims to be drawing.
//
// Until now this page had exactly one check anywhere in the suite: that it
// renders more than 200 characters and is not showing an error. That passes
// against a convincing, completely empty graph. What follows instead compares
// the counts the page prints against `kubectl get`, and then CHANGES the
// cluster and requires the graph to follow - a topology that agrees with the
// cluster once, by luck or by cache, is not the same as one that tracks it.
//
// Read off the running product before being written:
//  - The page prints a per-kind legend ("Deployment 15", "Pod 35") and a
//    "Showing N of N resources" total, and groups the graph by namespace.
//  - Deployment, Pod and Service counts match `kubectl get -A` exactly.
//  - ConfigMap does NOT: the page shows 4 where the cluster has 25, because a
//    relationship graph only carries the ones something references. Asserting
//    that one against kubectl would be inventing a defect, so this test states
//    which kinds it trusts and why.
//  - Individual resource NAMES are not in the rendered text - namespace groups
//    summarise as "16 Pods | 7 Deployments | +4". Counts are the honest anchor;
//    searching the page for a workload name reports a working graph as broken.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const FIXTURE_NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';

/** How many of a kind the cluster actually has, across all namespaces. */
function clusterCount(kind: string): number {
  return kubectl('get', kind, '-A', '--no-headers', '-o', 'name').split('\n').filter(Boolean).length;
}

/** The counts the page is currently claiming. */
async function shownCounts(page: Page): Promise<{ kinds: Record<string, number>; total: number | null }> {
  const text = await page.evaluate(() => document.body.innerText);
  const kinds: Record<string, number> = {};
  for (const kind of ['Deployment', 'Pod', 'Service', 'DaemonSet', 'StatefulSet']) {
    const m = text.match(new RegExp(`${kind}\\s*\\n?\\s*(\\d+)`));
    if (m) kinds[kind] = Number(m[1]);
  }
  const total = text.match(/Showing\s+\d+\s+of\s+(\d+)/);
  return { kinds, total: total ? Number(total[1]) : null };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
  // Connected is not the same as answering: the hub can hold an attached agent
  // that serves nothing, and every fleet-wide number then reads as zero.
  await waitForFleetReporting(page);
});

test('the topology graph counts the resources this cluster actually has', { tag: '@sanity' }, async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/topology');

  await expect
    .poll(async () => (await shownCounts(page)).total, {
      message: 'the topology page never printed a resource total, so it is not drawing a graph of anything',
      timeout: 60_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeGreaterThan(0);

  // Only the kinds verified to be counted the same way the cluster counts
  // them. See the header note on ConfigMap.
  //
  // Each kind is polled to convergence and then reported softly, so one wrong
  // count does not hide the other two - "Pods disagree" and "every kind
  // disagrees" point at completely different problems, and a hard assertion on
  // the first one loses that distinction.
  for (const kind of ['Deployment', 'Pod', 'Service']) {
    const actual = clusterCount(kind.toLowerCase());
    await expect
      .poll(async () => (await shownCounts(page)).kinds[kind], { timeout: 45_000, intervals: [2000, 3000, 5000] })
      .toBe(actual)
      .catch(() => {
        /* reported below, so the remaining kinds still get checked */
      });

    expect
      .soft(
        (await shownCounts(page)).kinds[kind],
        `topology shows a different number of ${kind}s than the cluster has (${actual} per kubectl) - ` +
          `the graph is drawing a fleet that does not exist, or is missing part of the one that does`,
      )
      .toBe(actual);
  }

  // The namespaces holding this run's fixtures must be represented - a graph
  // that omits the workloads the harness just created is not fleet-wide.
  const text = await page.evaluate(() => document.body.innerText);
  expect
    .soft(text, `topology does not mention ${FIXTURE_NS}, though every fixture workload lives there`)
    .toContain(FIXTURE_NS);

  await captureSurface(page, testInfo, 'topology-graph');
});

test('the topology graph follows the cluster when it changes', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/topology');

  const settled = async () => {
    await expect
      .poll(async () => (await shownCounts(page)).kinds.Deployment, { timeout: 60_000, intervals: [2000, 3000] })
      .toBeGreaterThan(0);
    return (await shownCounts(page)).kinds.Deployment as number;
  };

  const before = await settled();
  const name = `topo-probe-${Date.now()}`;
  let created = false;

  try {
    kubectl('create', 'deployment', name, '--image=nginx:alpine', '-n', FIXTURE_NS);
    created = true;

    // No reload. The point is that the page tracks the cluster on its own;
    // reloading would prove only that a fresh fetch works.
    await expect
      .poll(async () => (await shownCounts(page)).kinds.Deployment, {
        message:
          `a Deployment was created in ${FIXTURE_NS} and the topology graph never noticed - it showed ${before} ` +
          `before and did not move, so what a user sees is a snapshot, not their cluster`,
        timeout: 90_000,
        intervals: [3000, 3000, 5000, 5000],
      })
      .toBe(before + 1);

    await captureSurface(page, testInfo, 'topology-after-create');
  } finally {
    if (created) kubectl('delete', 'deployment', name, '-n', FIXTURE_NS, '--ignore-not-found');
  }

  // And back down again when it goes away.
  await expect
    .poll(async () => (await shownCounts(page)).kinds.Deployment, {
      message: `the deleted Deployment is still counted in the topology graph - removals do not reach the page`,
      timeout: 90_000,
      intervals: [3000, 3000, 5000, 5000],
    })
    .toBe(before);
});
