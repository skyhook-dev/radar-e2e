import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, captureSurface, kubectl } from './helpers';

// Pod logs is the suite's one STREAMING scenario. Everything else here is
// plain request/response; a pod's stdout travels over Server-Sent Events
// straight from radar's own process (no tunnel to go stale, unlike the hub
// variant of this spec) to the browser. Still worth its own coverage: SSE
// framing, keep-alives and the follow behavior are a genuinely different code
// path from the rest of the app.
//
// The chain under test: busybox loop writes to its own stdout -> kubelet
// captures it -> radar's workload-logs stream handler tails+follows it -> the
// Logs tab renders it.

const NAMESPACE = 'e2e-logs';
const runId = randomBytes(4).toString('hex');
const marker = `e2e-logs-${runId}`;
const DEPLOYMENT = `log-emitter-${runId}`;

/** Deploy a workload whose entire purpose is emitting lines we can uniquely
 * identify and independently re-read via `kubectl logs` as ground truth. */
function deployLogEmitter() {
  const manifest = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DEPLOYMENT}
  namespace: ${NAMESPACE}
  labels:
    app: ${DEPLOYMENT}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${DEPLOYMENT}
  template:
    metadata:
      labels:
        app: ${DEPLOYMENT}
    spec:
      containers:
        - name: emitter
          # Google's Docker Hub mirror, not Docker Hub itself - anonymous
          # pulls from shared CI egress addresses are rate-limited.
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
  kubectl('-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`, '--timeout=60s');
}

/** The pod's own stdout, read straight from the cluster - the ground truth
 * the UI assertions are checked against, never a fixture. */
function readPodLogsFromCluster(): string {
  const podName = kubectl(
    '-n', NAMESPACE, 'get', 'pods', '-l', `app=${DEPLOYMENT}`, '-o', 'jsonpath={.items[0].metadata.name}',
  );
  return kubectl('-n', NAMESPACE, 'logs', podName, '--tail=500');
}

/** Highest `counter=N` for our marker currently visible in the kubectl truth. */
function maxCounterInClusterLogs(): number {
  const text = readPodLogsFromCluster();
  const counters = [...text.matchAll(new RegExp(`${marker} counter=(\\d+)`, 'g'))].map((m) => Number(m[1]));
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

  // Landing straight on ?tab=logs already exercises the SSE path - the
  // Logs tab auto-streams on mount, not a separate "click Stream" step.
  await page.goto(`/workload/deployments/${NAMESPACE}/${DEPLOYMENT}?tab=logs`);
  await expect(page.getByRole('button', { name: /stop/i })).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(() => {
  deployLogEmitter();
});

test.afterAll(() => {
  kubectl('-n', NAMESPACE, 'delete', 'deployment', DEPLOYMENT, '--ignore-not-found', '--wait=false');
});

test("the Logs tab shows this pod's own log lines, verified against kubectl", async ({ page }, testInfo) => {
  await openLogsTab(page);

  await expect
    .poll(() => maxCounterInPage(page), {
      message: `no "${marker}" log lines ever reached the Logs tab - radar's log stream handler is broken`,
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

  await captureSurface(page, testInfo, 'logs-tab-streaming');
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

  await expect(page.getByRole('button', { name: /stop/i })).toBeVisible();

  const secondMax = await maxCounterInPage(page);
  await expect
    .poll(() => maxCounterInPage(page), {
      message: `Logs tab stalled again at counter=${secondMax} for ${marker} - the stream delivered one update and then stopped following`,
      timeout: 20_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(secondMax);
});
