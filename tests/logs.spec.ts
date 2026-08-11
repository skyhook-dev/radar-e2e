import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl } from './helpers';

// Pod logs are the suite's first STREAMING scenario. Everything else here is
// plain request/response; a pod's stdout travels over a long-lived SSE
// connection multiplexed through the hub's yamux tunnel to the in-cluster
// radar (see useLogStream.ts / handleWorkloadLogsStream). That path breaks
// independently of resources/timeline/helm - a tunnel that serves ordinary
// GETs just fine can still fail to keep a stream open - so it needs its own
// coverage rather than riding along on another spec.
//
// The chain under test:
//   busybox loop writes to its own stdout -> kubelet captures it -> radar's
//   workload-logs stream handler tails+follows it -> the hub proxies that SSE
//   stream through the tunnel -> the embedded RadarApp's WorkloadLogsViewer
//   renders it in the Logs tab.

const logsNamespace = 'e2e-logs';

/**
 * A per-run marker + monotonic counter, so the assertions below can only be
 * satisfied by THIS run's pod, live, right now - never by a stale render, a
 * leftover pod from an earlier run, or someone else's workload in the
 * cluster (other agents share this cluster).
 */
const runId = randomBytes(4).toString('hex');
const marker = `e2e-logs-${runId}`;
const deploymentName = `log-emitter-${runId}`;

/** Deploy a workload whose entire purpose is emitting lines we can uniquely
 * identify and independently re-read via `kubectl logs` as ground truth. */
function deployLogEmitter() {
  const manifest = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${logsNamespace}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${logsNamespace}
  labels:
    app: ${deploymentName}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      containers:
        - name: emitter
          # Pulled from Google's Docker Hub mirror rather than Docker Hub
          # itself: anonymous pulls from shared CI egress addresses are
          # rate-limited, and at this suite's cadence that failure would
          # surface as "log streaming is broken" rather than as a pull error.
          image: mirror.gcr.io/library/busybox:1.36
          command: ["/bin/sh", "-c"]
          args:
            - |
              i=0
              while true; do
                echo "${marker} counter=$i"
                i=$((i+1))
                sleep 1
              done
`.trimStart();

  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-logs-'));
  const manifestPath = path.join(dir, 'log-emitter.yaml');
  writeFileSync(manifestPath, manifest);
  try {
    kubectl('apply', '-f', manifestPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  kubectl(
    '-n',
    logsNamespace,
    'rollout',
    'status',
    `deployment/${deploymentName}`,
    '--timeout=60s',
  );
}

/** The pod's own stdout, read straight from the cluster - the ground truth
 * the UI assertions are checked against, never a fixture. */
function readPodLogsFromCluster(): string {
  const podName = kubectl(
    '-n',
    logsNamespace,
    'get',
    'pods',
    '-l',
    `app=${deploymentName}`,
    '-o',
    'jsonpath={.items[0].metadata.name}',
  );
  return kubectl('-n', logsNamespace, 'logs', podName, '--tail=500');
}

/** Highest `counter=N` for our marker currently visible in the kubectl truth. */
function maxCounterInClusterLogs(): number {
  const text = readPodLogsFromCluster();
  const counters = [...text.matchAll(new RegExp(`${marker} counter=(\\d+)`, 'g'))].map((m) =>
    Number(m[1]),
  );
  return counters.length > 0 ? Math.max(...counters) : -1;
}

/** Highest `counter=N` for our marker currently rendered in the Logs tab. */
async function maxCounterInPage(page: Page): Promise<number> {
  const lines = await page.getByText(new RegExp(`${marker} counter=\\d+`)).allTextContents();
  const counters = lines
    .map((line) => line.match(new RegExp(`${marker} counter=(\\d+)`)))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
  return counters.length > 0 ? Math.max(...counters) : -1;
}

async function openLogsTab(page: Page) {
  await page.goto('/');
  await assertClusterConnected(page);

  // Deployment kinds go through WORKLOAD_LOG_KINDS -> the aggregated
  // WorkloadLogsViewer, which auto-streams on mount (autoStream=true) rather
  // than showing a static snapshot first - so landing on ?tab=logs already
  // exercises the SSE path, not a separate "click Stream" step.
  await page.goto(`/c/${clusterId}/workload/deployments/${logsNamespace}/${deploymentName}?tab=logs`);

  // The stream needs the resource + pod list to resolve before the Logs tab
  // even renders (WorkloadView falls back to Overview while pods are still
  // loading) - wait for the tab content itself rather than a fixed sleep.
  await expect(page.getByRole('button', { name: /stop/i })).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through e2e/browser/run.sh');
  deployLogEmitter();
});

test.afterAll(() => {
  kubectl('-n', logsNamespace, 'delete', 'deployment', deploymentName, '--ignore-not-found', '--wait=false');
});

test('the Logs tab shows this pod\'s own log lines, verified against kubectl', async ({ page }, testInfo) => {
  await openLogsTab(page);

  // Wait for at least one of our marker lines to reach the UI, then check it
  // against what the pod itself reports - not just "some text containing the
  // marker appeared", but a specific counter value kubectl also has.
  await expect
    .poll(() => maxCounterInPage(page), {
      message: `no "${marker}" log lines ever reached the Logs tab - the radar -> tunnel -> hub log stream is broken`,
      timeout: 30_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThanOrEqual(0);

  const shownMax = await maxCounterInPage(page);
  const clusterMax = maxCounterInClusterLogs();
  expect(
    clusterMax,
    `UI shows counter=${shownMax} for ${marker} but kubectl logs never produced it - the UI is rendering something other than this pod's real output`,
  ).toBeGreaterThanOrEqual(shownMax);

  await testInfo.attach('logs-tab.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('new log lines appear live while the page stays open, with no reload', async ({ page }) => {
  await openLogsTab(page);

  await expect
    .poll(() => maxCounterInPage(page), {
      message: `${marker} never appeared in the Logs tab before the live-follow check could start`,
      timeout: 30_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThanOrEqual(0);

  const initialMax = await maxCounterInPage(page);

  // The emitter prints roughly once a second, so waiting on a strictly higher
  // counter to show up - without ever calling page.reload() or re-navigating -
  // is the only way to prove the SSE connection is actually pushing new
  // frames, as opposed to the earlier snapshot just sitting there rendered.
  await expect
    .poll(() => maxCounterInPage(page), {
      message: `Logs tab was stuck at counter=${initialMax} for ${marker} - new pod output is not arriving over the live stream`,
      timeout: 30_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(initialMax);

  // The stream must still be the thing driving this - if the toggle silently
  // flipped to "Stream" (stopped) partway through, a slow poll interval could
  // still observe a higher counter from a lucky manual refresh and hide that
  // the persistent connection actually died.
  await expect(page.getByRole('button', { name: /stop/i })).toBeVisible();

  // And the count must keep climbing on a second pass - not have topped out
  // (e.g. a stream that delivers one late burst and then silently stalls).
  const secondMax = await maxCounterInPage(page);
  await expect
    .poll(() => maxCounterInPage(page), {
      message: `Logs tab stalled again at counter=${secondMax} for ${marker} - the stream delivered one update and then stopped following`,
      timeout: 20_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(secondMax);
});
