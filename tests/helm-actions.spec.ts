import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertClusterConnected, clusterId, helm, kubectl } from './helpers';

// Helm WRITE path: upgrade and rollback. helm.spec.ts covers reads only -
// release data pulled out of the cluster and displayed. Writes are a
// different, riskier path: browser click -> hub API -> tunnel -> radar ->
// an actual `helm upgrade` / `helm rollback` against the live release,
// which can leave a release wedged if it goes wrong. Every assertion below
// checks the outcome with the `helm`/`kubectl` CLIs against real cluster
// state, never the UI's own optimistic rendering.
//
// Everything lives in a dedicated `e2e-helm-actions` namespace on a
// throwaway chart this spec installs and owns - never radar or radar-hub.
//
// KNOWN ISSUE (see KNOWN-ISSUES.md #3): on this stack, every Helm write
// attempted through the UI 403s with "Helm write operations require
// additional RBAC permissions. Set rbac.helm=true in the Radar Helm chart
// values." That is not a fluke of this harness - it is Radar's intentional,
// secure-by-default gate (Helm writes need `create/update/patch/delete` on
// every resource type, so the chart makes it opt-in). The bug is that the
// capability the UI uses to decide whether to SHOW enabled Upgrade/Rollback/
// Edit-Values controls (`/api/capabilities`, checked as the impersonated
// end user) is not the capability actually enforced when those controls are
// used (`requireHelmWrite`, checked as Radar's own ServiceAccount). An admin
// with full cluster RBAC sees fully-enabled write controls that always
// fail. Both tests below are written as if the write succeeded and marked
// `test.fail()` per the project convention - they turn the run red the
// moment someone fixes the mismatch (or provisions this stack with
// `rbac.helm=true`), which is the signal to delete the marker.
//
// Re-enabling either test for real: install Radar with
// `--set rbac.helm=true` (see deploy/helm/radar/templates/clusterrole.yaml).

const NAMESPACE = 'e2e-helm-actions';
const RELEASE = `helm-actions-probe-${Date.now()}`;
const V1_MESSAGE = 'hello-v1';
const V2_MESSAGE = 'hello-v2';

const CHART_YAML = `apiVersion: v2
name: helm-actions-probe
description: Throwaway chart for tests/helm-actions.spec.ts - not a product chart.
version: 0.1.0
appVersion: "1.0.0"
`;

const VALUES_YAML = `message: ${V1_MESSAGE}\n`;

// A ConfigMap key is the concrete, cheap-to-verify signal for the upgrade
// assertion. The Deployment adds a second real resource (registry.k8s.io/
// pause:3.9 - nothing to pull, nothing to wait on) so the release looks like
// a normal one in the Resources tab, without adding scheduling risk.
const CONFIGMAP_YAML = `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
data:
  message: {{ .Values.message | quote }}
`;

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      terminationGracePeriodSeconds: 5
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
`;

/** Chart lives outside the repo tree - this spec is the only file this task may touch. */
function writeChart(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-actions-chart-'));
  fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART_YAML);
  fs.writeFileSync(path.join(dir, 'values.yaml'), VALUES_YAML);
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.writeFileSync(path.join(dir, 'templates', 'configmap.yaml'), CONFIGMAP_YAML);
  fs.writeFileSync(path.join(dir, 'templates', 'deployment.yaml'), DEPLOYMENT_YAML);
  return dir;
}

function releaseValues(): { message?: string } {
  const raw = helm('-n', NAMESPACE, 'get', 'values', RELEASE, '-o', 'json');
  return raw ? (JSON.parse(raw) ?? {}) : {};
}

function releaseHistory(): Array<{ revision: number; status: string }> {
  return JSON.parse(helm('-n', NAMESPACE, 'history', RELEASE, '-o', 'json'));
}

function configMapMessage(): string {
  return kubectl('-n', NAMESPACE, 'get', 'configmap', RELEASE, '-o', 'jsonpath={.data.message}');
}

let chartPath: string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Idempotent, and tolerant of a namespace left mid-delete by a previous run:
 * `kubectl get` still reports a Terminating namespace as present, and `helm
 * install` into one fails ("unable to create new content ... being
 * terminated"), so create only once it is genuinely gone or already Active.
 */
async function ensureNamespace(): Promise<void> {
  // On a machine running several kind clusters at once, a namespace stuck
  // Terminating has been observed to take 5+ minutes to clear - budget well
  // past that rather than fail a rerun for a slow host.
  const maxAttempts = 90;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const phase = kubectl('get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'jsonpath={.status.phase}');
    if (phase === '') {
      kubectl('create', 'namespace', NAMESPACE);
      return;
    }
    if (phase === 'Active') return;
    await sleep(2000); // Terminating - wait it out rather than collide with it.
  }
  throw new Error(`namespace "${NAMESPACE}" was still Terminating after ${(maxAttempts * 2000) / 1000}s - a previous run's cleanup did not finish`);
}

test.beforeAll(async () => {
  // Generous: this machine runs several kind clusters at once, and a stale
  // namespace can still be Terminating from a previous run (ensureNamespace
  // waits that out rather than colliding with it) - budget covers a worst
  // case ~180s namespace wait plus a slow chart install.
  test.setTimeout(360_000);
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
  await ensureNamespace();

  chartPath = writeChart();
  helm('-n', NAMESPACE, 'install', RELEASE, chartPath, '--wait', '--timeout=120s');
});

test.afterAll(() => {
  try {
    helm('-n', NAMESPACE, 'uninstall', RELEASE);
  } catch {
    // Best-effort: the namespace delete below removes the release's storage
    // Secrets regardless, so a release that never installed isn't a leak.
  }
  kubectl('delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=false');
});

test('upgrading a release from the Values editor changes the cluster and advances the revision', async ({ page }, testInfo) => {
  test.fail(
    true,
    'KNOWN ISSUE 3: Helm write RBAC check uses a different identity in /api/capabilities than in requireHelmWrite, so the UI shows an enabled Upgrade control that always 403s. See KNOWN-ISSUES.md.',
  );
  test.setTimeout(150_000);

  await page.goto('/');
  await assertClusterConnected(page);

  const before = releaseValues();
  expect(before.message, 'probe release did not start with its chart default value').toBe(undefined);

  await page.goto(`/c/${clusterId}/helm`);
  await page.getByPlaceholder('Search releases...').fill(RELEASE);

  const table = page.getByRole('table').first();
  const row = table.getByRole('row').filter({ hasText: RELEASE });
  await expect(row.first(), `no Helm row for release "${RELEASE}" - kubectl/helm confirm it was installed`).toBeVisible();
  await row.first().click();
  await expect(page.getByRole('heading', { name: RELEASE })).toBeVisible();

  await page.getByRole('button', { name: 'Values' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();

  const editor = page.getByRole('textbox', { name: 'YAML editor' });
  await expect(editor, 'no YAML editor appeared after clicking Edit on the Values tab').toBeVisible();
  // Monaco's accessible "YAML editor" textbox is an invisible input host for
  // the browser's EditContext API - it never carries the rendered text, and
  // clicking it directly is blocked because its own .view-line child sits on
  // top and intercepts the point. The real click target, and the element
  // that actually reflects typed content, is .view-line / .view-lines.
  const editorLine = page.locator('.monaco-editor .view-line').first();
  await editorLine.click();
  await page.keyboard.press('ControlOrMeta+a');
  // insertText, not type(): per-key synthetic events outrun the EditContext
  // API's own input processing and drop characters ("message: hello-v2"
  // arrived as "me: he2" under plain type()).
  await page.keyboard.insertText(`message: ${V2_MESSAGE}`);
  const editorLines = page.locator('.monaco-editor .view-lines');
  await expect(
    editorLines,
    'typed values never landed in the YAML editor - Apply would be clicked with no real change',
  ).toContainText(V2_MESSAGE);

  // "Preview" opens a diff of what Apply would do (its own "Apply Changes"
  // button then applies it); the toolbar's plain "Apply" applies immediately
  // with no confirmation. Going through Preview exercises both.
  // The button is briefly disabled while the editor's own (debounced) YAML
  // validation catches up with what was just typed - wait it out rather
  // than race it.
  const previewButton = page.getByRole('button', { name: 'Preview', exact: true });
  await expect(previewButton, 'Preview stayed disabled after typing a valid value').toBeEnabled();
  await previewButton.click();

  const previewDialog = page.getByRole('dialog').filter({ hasText: 'Preview Changes' });
  await expect(previewDialog, 'no Preview Changes dialog opened after Preview').toBeVisible();
  await expect(
    previewDialog,
    `the manifest diff never showed the edited value "${V2_MESSAGE}" - the preview does not reflect what was typed`,
  ).toContainText(V2_MESSAGE);

  await previewDialog.getByRole('button', { name: 'Apply Changes' }).click();

  // Cluster truth: the release's user-supplied values AND the rendered
  // ConfigMap both carry the new message, and a new revision exists.
  await expect
    .poll(() => releaseValues().message, {
      message: `helm never reported an updated "message" value for release "${RELEASE}" after Apply - the edit never reached the cluster`,
      timeout: 20_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(V2_MESSAGE);

  await expect
    .poll(() => configMapMessage(), {
      message: `ConfigMap "${RELEASE}" in namespace "${NAMESPACE}" still holds the old message - the upgrade never reached a real Kubernetes object`,
      timeout: 15_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(V2_MESSAGE);

  const history = releaseHistory();
  expect(history.length, `helm history for "${RELEASE}" is still 1 entry - no new revision was created`).toBeGreaterThan(1);

  await testInfo.attach('upgrade-result.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('rolling back a release from History reverts the cluster to the previous revision', async ({ page }, testInfo) => {
  test.fail(
    true,
    'KNOWN ISSUE 3: Helm write RBAC check uses a different identity in /api/capabilities than in requireHelmWrite, so the UI shows an enabled Rollback control that always 403s. See KNOWN-ISSUES.md.',
  );
  test.setTimeout(150_000);

  // Independent of whether the upgrade test above actually advanced the
  // release (it is expected not to, in this environment) - rollback needs a
  // revision to roll back FROM. Created directly with the CLI, not through
  // the UI: this is fixture setup, not the write path under test.
  if (releaseHistory().length < 2) {
    helm('-n', NAMESPACE, 'upgrade', RELEASE, chartPath, '--set', `message=${V2_MESSAGE}`, '--wait', '--timeout=120s');
  }
  const beforeHistory = releaseHistory();
  const latestRevision = beforeHistory[beforeHistory.length - 1].revision;
  expect(latestRevision, 'setup for the rollback test did not leave the release at revision 2+').toBeGreaterThan(1);

  await page.goto('/');
  await assertClusterConnected(page);

  await page.goto(`/c/${clusterId}/helm`);
  await page.getByPlaceholder('Search releases...').fill(RELEASE);

  const table = page.getByRole('table').first();
  const row = table.getByRole('row').filter({ hasText: RELEASE });
  await expect(row.first(), `no Helm row for release "${RELEASE}" - kubectl/helm confirm it was installed`).toBeVisible();
  await row.first().click();
  await expect(page.getByRole('heading', { name: RELEASE })).toBeVisible();

  await page.getByRole('button', { name: 'History' }).click();
  await expect(
    page.getByText('Rollback', { exact: true }),
    'no Rollback control in History for the superseded revision - the UI does not offer rollback here',
  ).toBeVisible();
  await page.getByText('Rollback', { exact: true }).click();

  const confirmDialog = page.getByRole('dialog').filter({ hasText: 'Rollback Release' });
  await expect(confirmDialog, 'no Rollback Release confirmation dialog opened').toBeVisible();
  await expect(
    confirmDialog,
    `rollback confirmation did not name the release ("${RELEASE}") being rolled back`,
  ).toContainText(RELEASE);
  await confirmDialog.getByRole('button', { name: 'Rollback', exact: true }).click();

  // Cluster truth: a brand new revision appears (helm rollback always
  // creates one, it never rewrites history in place) and it carries
  // revision 1's values/ConfigMap content.
  await expect
    .poll(() => releaseHistory().length, {
      message: `helm history for "${RELEASE}" is still ${beforeHistory.length} entries after confirming Rollback in the UI - no new revision was created`,
      timeout: 20_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeGreaterThan(beforeHistory.length);

  await expect
    .poll(() => configMapMessage(), {
      message: `ConfigMap "${RELEASE}" never reverted to "${V1_MESSAGE}" after the rollback - cluster state does not match revision 1`,
      timeout: 15_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(V1_MESSAGE);

  const after = releaseHistory();
  expect(after[after.length - 1].status, 'the newest revision after rollback is not "deployed"').toBe('deployed');

  await testInfo.attach('rollback-result.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
