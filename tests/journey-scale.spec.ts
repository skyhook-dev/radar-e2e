import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  gotoWhenNotRateLimited,
  kubectl,
  waitForFleetReporting,
} from './helpers';

// The most ordinary thing an operator does: change how many replicas run.
//
// Nothing dramatic breaks here - no failure, no alert. That is the point. A
// routine scale has to reach every surface that claims to describe the
// workload, or those surfaces quietly drift from the cluster and the drift is
// only noticed during an incident, when it matters most.
//
// One scale, followed through:
//   Applications - the ready count on the workload's row
//   Resources    - one row per running pod
//   Topology     - the fleet-wide Pod total
//
// The cluster is waited on FIRST, through kubectl, before any surface is
// asked about it. Scaling up takes as long as it takes to pull and start
// containers, and folding that into a page's budget turns a slow kubelet into
// "the page does not update".
//
// storefront is used because nothing else manages it: the three HPAs in this
// namespace target hpa-pinned, hpa-paused and hpa-no-requests, and scaling a
// deployment an autoscaler owns would be reverted underneath the test.

test.use({ storageState: authStatePath });
test.setTimeout(600_000);
test.describe.configure({ mode: 'serial' });

const NAMESPACE = process.env.FIXTURE_NS ?? 'e2e-fixtures';
const WORKLOAD = 'storefront';
const SCALE_TO = 4;

/**
 * The name the Applications page files this workload under.
 *
 * It is NOT the deployment name. That page groups by the app.kubernetes.io
 * labels, so storefront - which carries part-of=shop - is listed as "shop" and
 * searching the page for "storefront" finds nothing at all. Read from the
 * cluster rather than hardcoded, so the test states the rule instead of
 * memorising one mapping.
 */
function applicationName(): string {
  const partOf = kubectl(
    'get', 'deployment', WORKLOAD, '-n', NAMESPACE,
    '-o', 'jsonpath={.metadata.labels.app\\.kubernetes\\.io/part-of}',
  );
  return partOf || WORKLOAD;
}

/** The workload's row on /applications, and what it says is ready. */
function applicationRow(page: Page, appName: string) {
  return page.locator('tbody tr').filter({ hasText: appName }).first();
}

/**
 * The ready count on that row as a pair, e.g. "2/2" -> [2, 2].
 *
 * Parsed rather than substring-matched. Scaling down passes through states
 * like 4/2 and 2/4 while pods terminate, and a substring check for "2/2"
 * cannot tell "not there yet" from "wrong", so it reports a page that is
 * mid-update as a page that never updates.
 */
async function readyPair(page: Page, appName: string): Promise<[number, number] | null> {
  const text = await applicationRow(page, appName).innerText().catch(() => '');
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

function desiredReplicas(): number {
  return Number(kubectl('get', 'deployment', WORKLOAD, '-n', NAMESPACE, '-o', 'jsonpath={.spec.replicas}') || '0');
}

function readyReplicas(): number {
  return Number(kubectl('get', 'deployment', WORKLOAD, '-n', NAMESPACE, '-o', 'jsonpath={.status.readyReplicas}') || '0');
}

/** Wait for the cluster itself, so the product is never blamed for kubelet. */
async function waitForReady(count: number) {
  await expect
    .poll(readyReplicas, {
      message: `${NAMESPACE}/${WORKLOAD} never reached ${count} ready replica(s) - a cluster problem, not a product one`,
      timeout: 300_000,
      intervals: [5000, 5000, 10_000],
    })
    .toBe(count);
}

/** Fleet-wide Pod count as topology prints it in its kind legend. */
async function topologyPods(page: Page): Promise<number | null> {
  const m = (await bodyText(page)).match(/Pod\s*\n?\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Pod rows on /resources for a name, which defaults to the Pods kind. */
async function resourceRowsFor(page: Page, name: string): Promise<number> {
  await gotoWhenNotRateLimited(page, '/resources');
  const search = page.getByPlaceholder('Search... (press /)').first();
  if (!(await search.count())) return -1;
  await search.fill(name);
  await page.waitForTimeout(3000);
  return page.locator('tbody tr').count();
}

let original = 0;

test.beforeAll(() => {
  original = desiredReplicas();
});

test.afterAll(async () => {
  if (original > 0 && desiredReplicas() !== original) {
    kubectl('scale', 'deployment', WORKLOAD, '-n', NAMESPACE, `--replicas=${original}`);
  }
});

test('scaling a workload up is reflected on every surface that describes it', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);
  // Connected is not the same as answering: the hub can hold an attached agent
  // that serves nothing, and every fleet-wide number then reads as zero.
  await waitForFleetReporting(page);

  expect(original, `${NAMESPACE}/${WORKLOAD} is not in this cluster, so there is nothing to scale`).toBeGreaterThan(0);

  await gotoWhenNotRateLimited(page, '/topology');
  const podsBefore = await topologyPods(page);

  kubectl('scale', 'deployment', WORKLOAD, '-n', NAMESPACE, `--replicas=${SCALE_TO}`);
  await waitForReady(SCALE_TO);

  // Applications: the ready count on this workload's OWN row. Checking the
  // whole page for "4/4" would pass on any other workload that happens to run
  // four replicas - and this namespace has several.
  const appName = applicationName();
  await gotoWhenNotRateLimited(page, '/applications');
  const appShowsIt = await expect
    .poll(async () => applicationRow(page, appName).innerText().catch(() => ''), {
      timeout: 90_000,
      intervals: [3000, 5000],
    })
    .toContain(`${SCALE_TO}/${SCALE_TO}`)
    .then(() => true)
    .catch(() => false);
  expect
    .soft(
      appShowsIt,
      `${WORKLOAD} runs ${SCALE_TO} ready replicas but the "${appName}" row on the Applications page never showed ` +
        `${SCALE_TO}/${SCALE_TO} - the list an operator uses to see what is running is behind the cluster`,
    )
    .toBe(true);
  await captureSurface(page, testInfo, 'journey-scale-applications');

  // Resources: one row per pod.
  const rows = await resourceRowsFor(page, WORKLOAD);
  expect
    .soft(rows, `${WORKLOAD} runs ${SCALE_TO} pods but the Resources table lists ${rows} row(s) for it`)
    .toBe(SCALE_TO);
  await captureSurface(page, testInfo, 'journey-scale-resources');

  // Topology: the fleet-wide pod total has to move by exactly what was added.
  if (podsBefore !== null) {
    await gotoWhenNotRateLimited(page, '/topology');
    const expected = podsBefore + (SCALE_TO - original);
    const moved = await expect
      .poll(async () => topologyPods(page), { timeout: 90_000, intervals: [3000, 5000] })
      .toBe(expected)
      .then(() => true)
      .catch(() => false);
    expect
      .soft(
        moved,
        `topology counted ${podsBefore} pods before ${WORKLOAD} was scaled from ${original} to ${SCALE_TO}, ` +
          `so it should now count ${expected} - the graph is not tracking the cluster`,
      )
      .toBe(true);
    await captureSurface(page, testInfo, 'journey-scale-topology');
  }
});

test('scaling back down is reflected just as quickly', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  kubectl('scale', 'deployment', WORKLOAD, '-n', NAMESPACE, `--replicas=${original}`);
  await waitForReady(original);

  const appName = applicationName();
  const backDown = await expect
    .poll(
      async () => {
        // Reloaded each time: coming down is slower than going up, because the
        // page keeps counting pods until they finish terminating.
        await gotoWhenNotRateLimited(page, '/applications');
        return (await readyPair(page, appName))?.join('/') ?? '';
      },
      { timeout: 240_000, intervals: [5000, 10_000, 15_000] },
    )
    .toBe(`${original}/${original}`)
    .then(() => true)
    .catch(() => false);
  expect
    .soft(
      backDown,
      `${WORKLOAD} is back to ${original} replicas but the "${appName}" row still reads ` +
        `${(await readyPair(page, appName))?.join('/') ?? 'nothing'} - surfaces that only grow are how stale ` +
        `counts survive`,
    )
    .toBe(true);

  const rows = await resourceRowsFor(page, WORKLOAD);
  expect
    .soft(rows, `${WORKLOAD} is back to ${original} pods but the Resources table still lists ${rows} row(s)`)
    .toBe(original);

  await captureSurface(page, testInfo, 'journey-scale-restored');
});
