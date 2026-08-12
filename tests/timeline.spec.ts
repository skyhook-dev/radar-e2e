import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  assertClusterConnected,
  clusterId,
  demoDeployment,
  demoNamespace,
  kubectl, captureSurface } from './helpers';

// Timeline end-to-end. The chain under test is:
//
//   kubectl change -> radar informer records it -> hub pulls it over the
//   tunnel -> hub serves /c/{id}/api/timeline/events -> the timeline page
//   renders it.
//
// Note on what is NOT covered: the self-hosted chart never sets
// HUB_TIMELINE_BACKEND, so hub-side retention is off and these endpoints
// delegate to the in-cluster radar (which itself defaults to in-memory
// storage). That is what the shipped chart does today, so it is what this
// tests. A retained-store variant belongs here once the chart can enable it.

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through e2e/browser/run.sh');
});

/** Scale the probe deployment to a value it is not currently at. */
function scaleProbeToNewReplicaCount(): number {
  const current = Number(
    kubectl('-n', demoNamespace, 'get', `deploy/${demoDeployment}`, '-o', 'jsonpath={.spec.replicas}'),
  );
  const target = current === 3 ? 2 : 3;
  kubectl('-n', demoNamespace, 'scale', `deploy/${demoDeployment}`, `--replicas=${target}`);
  return target;
}

async function fetchTimelineEvents(page: Page, sinceMs: number) {
  const res = await page.request.get(
    `/c/${clusterId}/api/timeline/events?from=${sinceMs}&to=${Date.now()}&limit=200`,
  );
  expect(
    res.status(),
    `timeline events endpoint returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
  ).toBe(200);
  // NDJSON: one event per line, plus a trailing cursor/end frame.
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind);
}

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
            e.name === demoDeployment &&
            e.namespace === demoNamespace &&
            JSON.stringify(e.diff ?? {}).includes(String(target)),
        ).length;
      },
      {
        message: `no timeline event for scaling ${demoNamespace}/${demoDeployment} to ${target} replicas - the radar -> tunnel -> hub timeline path is broken`,
        timeout: 60_000,
        intervals: [1000, 2000, 3000],
      },
    )
    .toBeGreaterThan(0);

  // Attach what was actually matched. A green tick in a 3am run is a claim;
  // the event rows are the evidence for it.
  const matched = (await fetchTimelineEvents(page, since)).filter(
    (e) => e.kind === 'Deployment' && e.name === demoDeployment,
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
  await page.goto(`/c/${clusterId}/timeline`);

  // The histogram strip is the timeline surface itself; without it the page
  // rendered but the view did not.
  await expect(page.getByTestId('strip-histogram')).toBeVisible();

  // And the change we just made is on it, by resource name. Waiting rather
  // than reloading in a loop: on a slower machine a reload every few seconds
  // discards the in-flight fetch before its data lands, so the page never
  // finishes loading and the row can never appear - a self-inflicted failure
  // that looks exactly like a broken timeline.
  await expect
    .poll(() => page.getByText(demoDeployment).count(), {
      message: `timeline page never showed ${demoDeployment} after scaling it to ${target} replicas`,
      timeout: 90_000,
      intervals: [1000, 2000, 3000, 5000],
    })
    .toBeGreaterThan(0);

  // The screenshot is the point of running a browser at all: it is the only
  // artifact that shows the timeline as a user would see it.
  await captureSurface(page, testInfo, 'timeline-change-rendered');
});
