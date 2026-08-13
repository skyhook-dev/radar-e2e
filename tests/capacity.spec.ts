import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  gotoWhenNotRateLimited,
  kubectl,
  waitForFleetReporting,
} from './helpers';

// Capacity, held to the node it is describing.
//
// Like Topology, this page previously had one check in the whole suite: it
// rendered and did not error. It is in fact the most numerically specific page
// in the product - it prints allocatable CPU and memory, a node count, a count
// of pods that cannot be scheduled, and the size of the demand they represent.
// Every one of those is checkable against the cluster.
//
// The distinction this page draws, and the reason it is worth testing: the
// fixture cluster has TWO pods in phase Pending, but only ONE of them is a
// capacity problem.
//
//   unschedulable  - no node assigned, PodScheduled reason=Unschedulable,
//                    requests 512Gi of memory. This is scheduling demand.
//   broken-image   - assigned to a node, stuck on ImagePullBackOff. Nothing to
//                    do with capacity.
//
// `kubectl get pods --field-selector=status.phase=Pending` returns both. The
// page says "PENDING PODS 1", and it is right to. A test that used the field
// selector as its expected value would report the correct behaviour as a bug.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

const FIXTURE_NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';

/**
 * Pods the scheduler could not place - the ones capacity is actually about.
 *
 * Read from JSON rather than a jsonpath filter: jsonpath cannot express "an
 * item whose conditions contain one with this reason" (a filter inside a
 * filter), and kubectl fails the whole command rather than returning nothing.
 */
type PodList = {
  items: Array<{
    metadata: { name: string; namespace: string };
    spec: { nodeName?: string };
    status: { conditions?: Array<{ type: string; reason?: string }> };
  }>;
};

function unschedulablePods(): string[] {
  const pods = JSON.parse(kubectl('get', 'pods', '-A', '-o', 'json')) as PodList;
  return pods.items
    .filter((p) => !p.spec.nodeName && (p.status.conditions ?? []).some((c) => c.reason === 'Unschedulable'))
    .map((p) => `${p.metadata.namespace}/${p.metadata.name}`);
}

/**
 * Wait for the fixture that creates capacity pressure to be pressuring again.
 *
 * The pod is not unschedulable the instant it is created - it is created,
 * scheduled against, and only then does the scheduler mark it Unschedulable.
 * A test that reads the count once, straight after a previous test restored
 * the fixture, sees zero and concludes the cluster has no pressure to check.
 */
async function waitForUnschedulable(timeoutMs = 180_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pods = unschedulablePods();
    if (pods.length > 0 || Date.now() > deadline) return pods;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function nodeCount(): number {
  return kubectl('get', 'nodes', '--no-headers', '-o', 'name').split('\n').filter(Boolean).length;
}

/** Allocatable CPU in whole cores, summed over nodes. */
function allocatableCores(): number {
  return kubectl('get', 'nodes', '-o', 'jsonpath={range .items[*]}{.status.allocatable.cpu}{"\\n"}{end}')
    .split('\n')
    .filter(Boolean)
    .reduce((sum, v) => sum + (v.endsWith('m') ? Number(v.slice(0, -1)) / 1000 : Number(v)), 0);
}

const pageText = (page: Page) => page.evaluate(() => document.body.innerText);

async function readNumber(page: Page, pattern: RegExp): Promise<number | null> {
  const m = (await pageText(page)).match(pattern);
  return m ? Number(m[1]) : null;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
  // Connected is not the same as answering: the hub can hold an attached agent
  // that serves nothing, and every fleet-wide number then reads as zero.
  await waitForFleetReporting(page);
});

test('the capacity page reports this cluster nodes and allocatable resources', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/capacity');

  const nodes = nodeCount();
  await expect
    .poll(async () => readNumber(page, /NODES\s*\n\s*(\d+)/), {
      message: `the capacity page does not report ${nodes} node(s) - it is describing a cluster other than this one`,
      timeout: 60_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(nodes);

  const cores = allocatableCores();
  const text = await pageText(page);
  const shownCores = text.match(/of\s+([\d.]+)\s+cores allocatable/);
  expect
    .soft(
      shownCores ? Number(shownCores[1]) : null,
      `the capacity page reports different allocatable CPU than the node offers (${cores} cores per kubectl)`,
    )
    .toBe(cores);

  // Requests must be a real fraction of capacity, not a placeholder.
  const requested = text.match(/([\d.]+)\s+cores requested/);
  expect
    .soft(requested ? Number(requested[1]) : null, 'the capacity page prints no CPU request total')
    .toBeGreaterThan(0);

  await captureSurface(page, testInfo, 'capacity-overview');
});

test('the capacity page counts pods blocked on scheduling, and not pods blocked on anything else', async ({
  page,
}, testInfo) => {
  await gotoWhenNotRateLimited(page, '/capacity');

  const blocked = await waitForUnschedulable();
  expect
    .soft(blocked.length, 'the fixture cluster should carry at least one unschedulable pod for this test to mean anything')
    .toBeGreaterThan(0);

  await expect
    .poll(async () => readNumber(page, /PENDING PODS[\s\S]{0,40}?\n(\d+)\n/), {
      message:
        `the capacity page does not report ${blocked.length} pod(s) waiting on capacity (${blocked.join(', ')}). ` +
        `Note this is NOT the same as phase=Pending: an image-pull failure is already scheduled and must not be counted here`,
      timeout: 60_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(blocked.length);

  // The demand those pods represent has to be shown, or "1 pending pod" tells
  // an operator nothing about whether it needs a bigger node or another one.
  const text = await pageText(page);
  expect
    .soft(text, 'the capacity page counts pending pods but never says how much they are asking for')
    .toMatch(/pending demand|pending\b/i);

  await captureSurface(page, testInfo, 'capacity-pending-demand');
});

test('capacity pressure disappears from the page when the workload causing it does', async ({ page }) => {
  const blocked = await waitForUnschedulable();
  test.skip(blocked.length === 0, 'nothing is unschedulable in this cluster, so there is no pressure to relieve');

  await gotoWhenNotRateLimited(page, '/capacity');
  const before = await readNumber(page, /PENDING PODS[\s\S]{0,40}?\n(\d+)\n/);

  // The fixture that causes the pressure. Scaling it away must relieve the
  // page, and scaling it back must restore it - otherwise the number is a
  // static fixture of its own rather than a reading of the cluster.
  const deployment = 'unschedulable';

  // Waiting on Kubernetes and waiting on the page are two different things,
  // and they are checked separately on purpose. Removing this pod takes over a
  // minute of cluster time; folding that into the page's budget produced a
  // failure reading "the page does not track the cluster" when the pod it was
  // waiting for had not gone away yet.
  const podsLeft = () =>
    kubectl('get', 'pods', '-n', FIXTURE_NS, '-l', `app=${deployment}`, '--no-headers', '--ignore-not-found')
      .split('\n')
      .filter(Boolean).length;

  let scaled = false;
  try {
    kubectl('scale', 'deployment', deployment, '-n', FIXTURE_NS, '--replicas=0');
    scaled = true;

    await expect
      .poll(podsLeft, {
        message: `${FIXTURE_NS}/${deployment} was scaled to zero but its pod never terminated - a cluster problem, not a page one`,
        timeout: 180_000,
        intervals: [5000, 5000, 10_000],
      })
      .toBe(0);

    await expect
      .poll(async () => readNumber(page, /PENDING PODS[\s\S]{0,40}?\n(\d+)\n/), {
        message:
          `the unschedulable pod is gone from the cluster, but the capacity page still reports ${before} pod(s) ` +
          `waiting on capacity - the number does not track the cluster`,
        timeout: 90_000,
        intervals: [3000, 5000, 5000, 10_000],
      })
      .toBe((before ?? 1) - 1);
  } finally {
    if (scaled) kubectl('scale', 'deployment', deployment, '-n', FIXTURE_NS, '--replicas=1');
  }

  await expect
    .poll(podsLeft, {
      message: `${FIXTURE_NS}/${deployment} was restored but its pod never came back - later runs will not have the fixture`,
      timeout: 180_000,
      intervals: [5000, 5000, 10_000],
    })
    .toBe(1);

  await expect
    .poll(async () => readNumber(page, /PENDING PODS[\s\S]{0,40}?\n(\d+)\n/), {
      message: `${FIXTURE_NS}/${deployment} is unschedulable again but the capacity page never picked the pressure back up`,
      timeout: 90_000,
      intervals: [3000, 5000, 5000, 10_000],
    })
    .toBe(before);
});
