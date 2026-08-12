import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, captureSurface, kubectl } from './helpers';

// Network diagnostics ("Diagnose" / "Reachability"). radar can probe whether
// a workload is actually reachable and report a verdict. This spec builds
// THREE Services with known, deliberately different real outcomes and checks
// radar's verdict against ground truth established independently via
// kubectl/exec - never against a fixture.
//
// IMPORTANT DIFFERENCE FROM THE HUB'S EQUIVALENT SUITE: this binary runs on
// the machine driving the test, not as a Pod inside the cluster. probe.
// DetectVantage() keys off KUBERNETES_SERVICE_HOST, which is only set inside
// a Pod - so every probe here runs from vantage "local" and reaches the
// Service through the kube-apiserver's services/proxy subresource, not a
// direct in-cluster dial. That is a WEAKER, indirect signal by design (the
// apiserver relaying a request proves something answers, not that the
// ordinary Service/CNI data path works) - confirmed live against this
// harness: verdict/headline/confidence read "reached via API server" /
// "indirect", never "healthy" / "real". A CLI user gets the stronger,
// real-data-path verdict only by clicking "Test in-cluster" (spins up a
// throwaway probe Pod); that flow is NOT covered here (see run notes for why).
//
// The chain under test: kubectl creates Services with different real
// reachability -> GET /api/trace/{Kind}/{ns}/{name}?probe=true runs radar's
// local-vantage probe -> the Reachability tab renders the same verdict.
//
// All three Services point at ONE tiny pod (busybox httpd), so the fixture
// stays small: only what differs (the Service's own port wiring / selector)
// changes per case, not the backend.

const NAMESPACE = 'e2e-diagnose';
const runId = randomBytes(4).toString('hex');
const deploymentName = `diag-web-${runId}`;
const healthySvc = `diag-healthy-${runId}`;
const wrongPortSvc = `diag-wrongport-${runId}`;
const noEndpointsSvc = `diag-noendpoints-${runId}`;

/**
 * One pod serving real HTTP on :8080, plus three Services with different
 * wiring onto it:
 *  - healthySvc:      80 -> 8080 (the port the pod actually listens on)
 *  - wrongPortSvc:    80 -> 9999 (pod is up and ready, nothing listens on 9999)
 *  - noEndpointsSvc:  selector matches no pods at all (zero ready endpoints)
 */
function deployFixture() {
  const manifest = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${NAMESPACE}
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
        - name: web
          image: mirror.gcr.io/library/busybox:1.36
          command: ["/bin/sh", "-c"]
          args:
            - |
              mkdir -p /www
              echo ok > /www/index.html
              httpd -f -p 8080 -h /www
          ports:
            - containerPort: 8080
          readinessProbe:
            tcpSocket:
              port: 8080
            initialDelaySeconds: 1
            periodSeconds: 2
---
apiVersion: v1
kind: Service
metadata:
  name: ${healthySvc}
  namespace: ${NAMESPACE}
spec:
  selector:
    app: ${deploymentName}
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: ${wrongPortSvc}
  namespace: ${NAMESPACE}
spec:
  selector:
    app: ${deploymentName}
  ports:
    - port: 80
      targetPort: 9999
---
apiVersion: v1
kind: Service
metadata:
  name: ${noEndpointsSvc}
  namespace: ${NAMESPACE}
spec:
  selector:
    app: nothing-matches-${runId}
  ports:
    - port: 80
      targetPort: 8080
`.trimStart();

  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-diagnose-'));
  const manifestPath = path.join(dir, 'fixture.yaml');
  writeFileSync(manifestPath, manifest);
  try {
    kubectl('apply', '-f', manifestPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  kubectl('-n', NAMESPACE, 'rollout', 'status', `deployment/${deploymentName}`, '--timeout=60s');
}

/** Real HTTP ground truth, read straight from the pod - independent of what
 *  the Service does with it, and independent of radar entirely. */
function podServesHTTP(): boolean {
  const podName = kubectl(
    '-n', NAMESPACE, 'get', 'pods', '-l', `app=${deploymentName}`, '-o', 'jsonpath={.items[0].metadata.name}',
  );
  const out = kubectl('-n', NAMESPACE, 'exec', podName, '--', 'wget', '-qO-', 'http://localhost:8080/');
  return out.trim() === 'ok';
}

/** Ground truth for the wrong-port case: proves nothing answers on 9999 in
 *  the SAME network namespace the Service would route into - not a guess. */
function nothingListensOn9999(): boolean {
  const podName = kubectl(
    '-n', NAMESPACE, 'get', 'pods', '-l', `app=${deploymentName}`, '-o', 'jsonpath={.items[0].metadata.name}',
  );
  try {
    kubectl('-n', NAMESPACE, 'exec', podName, '--', 'nc', '-z', '-w', '2', 'localhost', '9999');
    return false; // nc succeeded - something IS listening, ground truth assumption broken
  } catch {
    return true; // connection refused/timed out - nothing listens, as intended
  }
}

/** Ground truth for the no-endpoints case: the EndpointSlice controller's own
 *  count of ready backends for the Service - not radar's opinion of it. */
function readyEndpointCount(svc: string): number {
  const out = kubectl('-n', NAMESPACE, 'get', 'endpointslice', '-l', `kubernetes.io/service-name=${svc}`, '-o', 'json');
  const slices = JSON.parse(out).items as { endpoints?: { conditions?: { ready?: boolean } }[] }[];
  return slices.flatMap((s) => s.endpoints ?? []).filter((e) => e.conditions?.ready).length;
}

interface RouteResult {
  outcome: string;
  confidence: string;
  failedLayer?: string;
  evidence?: string;
}
interface TraceHop {
  resource: { kind: string; namespace: string; name: string };
  findings?: { code: string; message: string }[];
  meta?: { ready?: number };
}
interface TraceResponse {
  verdict: string;
  headline?: string;
  runVantage?: string;
  routes?: RouteResult[];
  downstream?: TraceHop[];
  diagnosis?: { summary: string };
  coverage?: { tested: number; passed: number; failed: number; skipped: number };
}

/** Hits the SAME endpoint the Reachability tab calls
 *  (GET /api/trace/{kind}/{ns}/{name}?probe=true). Polled because the probe
 *  is a live network operation, not because retries paper over flakiness. */
async function fetchTrace(page: Page, svc: string): Promise<TraceResponse> {
  let last: TraceResponse | undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/trace/Service/${NAMESPACE}/${svc}?probe=true`);
        if (res.status() !== 200) return `http ${res.status()}`;
        last = (await res.json()) as TraceResponse;
        return last.coverage && last.coverage.tested + last.coverage.failed + last.coverage.passed > 0
          ? 'probed'
          : `not yet probed: ${JSON.stringify(last)}`;
      },
      {
        message: `radar never returned a probed trace for ${svc} - the probe path is broken`,
        timeout: 30_000,
        intervals: [500, 1000, 2000, 3000],
      },
    )
    .toBe('probed');
  return last!;
}

test.beforeAll(() => {
  deployFixture();

  // Every verdict below depends on the cluster's OWN endpoint plumbing being
  // alive. On a resource-starved kind cluster (several kind clusters sharing
  // one Docker VM's CPU is enough) the controller-manager can crash-loop out
  // of leader election, at which point the EndpointSlice controller stops
  // populating and a perfectly healthy Service has no ready backends - radar
  // then correctly reports it unreachable, and this spec would read that
  // truthful verdict as the product lying. Fail here, with the real reason,
  // rather than there. (Observed live while developing this suite: kind
  // clusters sharing this Docker Desktop VM with several others crash-looped
  // kube-controller-manager/kube-scheduler on leader-election lease renewal
  // for ~90s after creation before self-healing - a machine/CI-capacity
  // condition, not a radar bug.)
  // `rollout status` above only proves the Pod passed its readiness probe -
  // the EndpointSlice controller updates asynchronously and can lag it by a
  // second or two even on a healthy cluster, which a single immediate check
  // would misreport as the crash-looping-controller case below. Poll briefly
  // before concluding the cluster itself is unhealthy.
  let ready = '';
  const deadline = Date.now() + 15_000;
  do {
    ready = kubectl(
      '-n', NAMESPACE, 'get', 'endpointslices', '-l', `kubernetes.io/service-name=${healthySvc}`,
      '-o', 'jsonpath={.items[*].endpoints[*].conditions.ready}',
    );
    if (ready.includes('true')) break;
  } while (Date.now() < deadline);
  if (!ready.includes('true')) {
    throw new Error(
      `${NAMESPACE}/${healthySvc} has no ready endpoints, so no reachability verdict here would mean anything. ` +
        `This is usually the cluster, not the product: check kube-controller-manager ` +
        `(a crash-looping one stops populating EndpointSlices). Ready conditions seen: "${ready}"`,
    );
  }
});

test.afterAll(() => {
  kubectl('-n', NAMESPACE, 'delete', 'deployment', deploymentName, '--ignore-not-found', '--wait=false');
  kubectl('-n', NAMESPACE, 'delete', 'service', healthySvc, wrongPortSvc, noEndpointsSvc, '--ignore-not-found');
});

test('radar reports a healthy Service as reached, backed by a real HTTP 200', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  expect(podServesHTTP(), `ground truth broke: the pod behind ${healthySvc} did not answer HTTP 200 on :8080`).toBe(
    true,
  );

  const trace = await fetchTrace(page, healthySvc);
  expect(
    trace.runVantage,
    'the CLI runs on the laptop driving the test, not as a Pod in the cluster - DetectVantage() must read "local"',
  ).toBe('local');
  expect(
    trace.headline,
    `expected an apiserver-relayed "reached" headline for ${healthySvc}, got: "${trace.headline}"`,
  ).toMatch(/^Reached via API server/);
  const route = trace.routes?.[0];
  expect(route?.outcome, `route outcome for ${healthySvc}`).toMatch(/^(reached|verified)$/);
  expect(
    route?.confidence,
    'from local vantage every probe is relayed through the kube-apiserver proxy - confidence must read "indirect", never "real" (that would mean the live data path was confirmed, which it was not)',
  ).toBe('indirect');
  expect(route?.evidence ?? '', `evidence for ${healthySvc}`).toContain('200');

  await testInfo.attach('healthy-service-trace.json', {
    body: JSON.stringify(trace, null, 2),
    contentType: 'application/json',
  });
});

test('radar reports a Service with no listener on its target port as unreachable, and names the real cause', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  expect(
    nothingListensOn9999(),
    'ground truth broke: something now listens on :9999, so this case no longer proves what it claims to',
  ).toBe(true);

  const trace = await fetchTrace(page, wrongPortSvc);
  expect(trace.headline, `headline should read as unreachable, got: "${trace.headline}"`).toMatch(/Unreachable/);
  const route = trace.routes?.[0];
  expect(route?.outcome, `route outcome for ${wrongPortSvc}`).toBe('unreachable');
  expect(route?.confidence, 'local-vantage probes are always relayed through the apiserver, never a direct dial').toBe('indirect');
  // The probe IS the apiserver's HTTP proxy call - there is no raw TCP layer
  // from this vantage, so the failure is attributed to "http", not "tcp"
  // (the in-cluster-vantage case would fail at "tcp" instead).
  expect(route?.failedLayer, 'the failing layer from local vantage is the HTTP proxy call itself').toBe('http');
  expect(route?.evidence ?? '', `evidence for ${wrongPortSvc}`).toMatch(/refused/i);

  // Specific, not just "unreachable": radar's config check independently
  // names the exact cause (targetPort points at a port the ready pod never
  // declared) - this is the "genuinely tricky" case, config LOOKS fine (pod
  // is ready) but the wiring is wrong, and both the static check and the
  // live probe agree.
  const svcHop = trace.downstream?.find((h) => h.resource.kind === 'Service' && h.resource.name === wrongPortSvc);
  expect(
    svcHop?.findings?.some((f) => f.code === 'svc:targetport-no-listener'),
    `expected radar to name the specific cause (targetPort mismatch) for ${wrongPortSvc}, findings were: ${JSON.stringify(svcHop?.findings)}`,
  ).toBe(true);

  await testInfo.attach('wrong-port-service-trace.json', {
    body: JSON.stringify(trace, null, 2),
    contentType: 'application/json',
  });
});

test('radar reports a Service with zero ready endpoints as unreachable and names the real cause', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  expect(
    readyEndpointCount(noEndpointsSvc),
    `ground truth broke: ${noEndpointsSvc} unexpectedly has ready endpoints`,
  ).toBe(0);

  const trace = await fetchTrace(page, noEndpointsSvc);
  expect(trace.headline, `headline should read as unreachable, got: "${trace.headline}"`).toMatch(/Unreachable/);
  expect(trace.routes?.[0]?.outcome, `route outcome for ${noEndpointsSvc}`).toBe('unreachable');

  // Specific, not interchangeable with the wrong-port case above: this
  // Service is broken for a DIFFERENT reason (selector matches nothing, not
  // a bad port), and radar's own diagnosis must say so.
  expect(
    trace.diagnosis?.summary ?? '',
    `expected radar to name "selector matches no pods" as the cause for ${noEndpointsSvc}, got: ${JSON.stringify(trace.diagnosis)}`,
  ).toMatch(/[Ss]elector matches no pods/);
  const podsHop = trace.downstream?.find((h) => h.resource.kind === 'Pods');
  expect(podsHop?.meta?.ready, 'the Pods hop must independently confirm zero ready endpoints, matching the EndpointSlice truth').toBe(0);

  await testInfo.attach('no-endpoints-service-trace.json', {
    body: JSON.stringify(trace, null, 2),
    contentType: 'application/json',
  });
});

test('the Reachability tab shows the same headline a user would see', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  await page.goto(`/workload/services/${NAMESPACE}/${healthySvc}?tab=reachability`);

  const reachabilityTab = page.getByRole('tab', { name: /reachability/i });
  await expect(
    reachabilityTab,
    'the Reachability tab never appeared - a user has no way to reach network diagnostics for this resource at all',
  ).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText(/^Reached via API server/)).toBeVisible({ timeout: 15_000 });

  await captureSurface(page, testInfo, 'reachability-tab-healthy');
});
