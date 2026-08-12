import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, captureSurface, kubectl } from './helpers';

// Timeline end-to-end. The chain under test:
//
//   kubectl change -> radar's own informer records it into its in-process
//   timeline store (no hub, no retention config to worry about - this is
//   exactly what `--timeline-storage=memory`, the CLI default, does) ->
//   GET /api/timeline/events -> the Timeline page renders it.

const NAMESPACE = 'e2e-timeline';
const DEPLOYMENT = 'timeline-probe';

function ensureProbeDeployment() {
  try {
    kubectl('get', 'namespace', NAMESPACE);
  } catch {
    kubectl('create', 'namespace', NAMESPACE);
  }
  try {
    kubectl('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE);
  } catch {
    kubectl(
      'create',
      'deployment',
      DEPLOYMENT,
      '-n',
      NAMESPACE,
      '--image=registry.k8s.io/pause:3.9',
      '--replicas=2',
    );
  }
  kubectl('rollout', 'status', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, '--timeout=60s');
}

/** Scale the probe deployment to a value it is not currently at. */
function scaleProbeToNewReplicaCount(): number {
  const current = Number(
    kubectl('-n', NAMESPACE, 'get', `deploy/${DEPLOYMENT}`, '-o', 'jsonpath={.spec.replicas}'),
  );
  const target = current === 3 ? 2 : 3;
  kubectl('-n', NAMESPACE, 'scale', `deploy/${DEPLOYMENT}`, `--replicas=${target}`);
  return target;
}

async function fetchTimelineEvents(page: Page, sinceMs: number) {
  const res = await page.request.get(`/api/timeline/events?from=${sinceMs}&to=${Date.now()}&limit=200`);
  expect(
    res.status(),
    `timeline events endpoint returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
  ).toBe(200);
  // NDJSON: one event per line, plus a trailing cursor/end frame (no `kind`).
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind);
}

test.beforeAll(() => {
  ensureProbeDeployment();
});

test('a change made now reaches the timeline', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // Start the window slightly before the change so a clock skew of a second
  // between this machine and the cluster cannot hide the event.
  const since = Date.now() - 60_000;
  const target = scaleProbeToNewReplicaCount();

  await expect
    .poll(
      async () => {
        const events = await fetchTimelineEvents(page, since);
        return events.filter(
          (e) =>
            e.kind === 'Deployment' &&
            e.name === DEPLOYMENT &&
            e.namespace === NAMESPACE &&
            JSON.stringify(e.diff ?? {}).includes(String(target)),
        ).length;
      },
      {
        message: `no timeline event for scaling ${NAMESPACE}/${DEPLOYMENT} to ${target} replicas - the informer -> timeline store path is broken`,
        timeout: 60_000,
        intervals: [1000, 2000, 3000],
      },
    )
    .toBeGreaterThan(0);

  // Attach what was actually matched. A green tick is a claim; the event
  // rows are the evidence for it.
  const matched = (await fetchTimelineEvents(page, since)).filter(
    (e) => e.kind === 'Deployment' && e.name === DEPLOYMENT,
  );
  await testInfo.attach('matched-timeline-events.json', {
    body: JSON.stringify(matched.slice(0, 10), null, 2),
    contentType: 'application/json',
  });
});

test('the timeline page renders the cluster timeline', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  const target = scaleProbeToNewReplicaCount();
  await page.goto('/timeline');

  // The histogram strip is the timeline surface itself; without it the page
  // rendered but the view did not.
  await expect(page.getByTestId('strip-histogram')).toBeVisible();

  // And the change we just made is on it, by resource name. Waiting rather
  // than reloading in a loop: a reload every few seconds discards the
  // in-flight fetch before its data lands, so on a slower machine the page
  // would never finish loading and the row could never appear - a
  // self-inflicted failure that looks exactly like a broken timeline.
  await expect
    .poll(() => page.getByText(DEPLOYMENT).count(), {
      message: `timeline page never showed ${DEPLOYMENT} after scaling it to ${target} replicas`,
      timeout: 90_000,
      intervals: [1000, 2000, 3000, 5000],
    })
    .toBeGreaterThan(0);

  await captureSurface(page, testInfo, 'timeline-change-rendered');
});
