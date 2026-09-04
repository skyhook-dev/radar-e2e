import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited, kubectl } from './helpers';

// Custom resources: does Radar show a kind it was never taught about?
//
// Every integration this product has shipped - CNPG, Velero, Kyverno,
// Crossplane, Karpenter, Argo - is a CRD read through the same generic path.
// That path had no coverage at all before this spec: the harness cluster ships
// with no CRDs beyond what kind itself installs, so nothing here ever loaded a
// custom resource, let alone checked what was rendered.
//
// It is also where the bugs are. A single review of the Velero / CNPG /
// Kyverno surfaces filed 22 correctness defects, and the fix log since is a
// steady run of "this status is reported as the wrong thing".
//
// This spec deliberately does NOT assert any of those integration-specific
// behaviours. Each scenario runs twice, against a build from main and against
// the published release, and every one of those fixes is newer than the
// release - asserting them here would turn the published half red every night
// and say nothing about the code under test. What it asserts instead is the
// contract underneath all of them, which both builds share: a CRD Radar has
// no curated opinion about is listed, counted, and rendered through its OWN
// printer columns, with the values the API server reports.
//
// Nothing is hardcoded. Every expectation is read from kubectl at run time, so
// this survives rewording of the UI - which is the failure mode that let a
// three-day outage of this suite look like a product regression last week.
//
// Why this owns a scenario: radar runs CRD discovery exactly ONCE, in a
// background goroutine at startup (internal/k8s/subsystems.go calls
// DiscoverAllCRDs there and nowhere else - no ticker, no watch-driven
// rediscovery). A CRD created after radar starts is invisible until it
// restarts, so this spec restarts it. That is safe only on a cluster it owns,
// which is the same reason tests/gitops.spec.ts has its own scenario. Further
// CRD coverage belongs in this scenario rather than in a new one - the cluster
// and the restart are already paid for here.

test.use({ storageState: authStatePath });
// Deliberately short. Each failure previously burned the full timeout twice
// over (once per retry), and two of them took the job past the 30-minute
// ceiling in .github/workflows/e2e.yml, so the run was cancelled before
// Playwright could even print why. A spec that cannot explain its own failure
// inside the budget is worse than no spec.
test.setTimeout(150_000);

const NS = 'e2e-crd';
const GROUP = 'e2e.skyhook.io';
const PLURAL = 'widgets';
const KIND = 'Widget';
const CRD_NAME = `${PLURAL}.${GROUP}`;
const RBAC_NAME = 'e2e-crd-rendering-reader';

/**
 * The objects this spec creates, and the values it will look for on screen.
 * Distinct on every field so a column rendering the WRONG object's value, or
 * the wrong field of the right object, cannot pass by coincidence.
 */
const WIDGETS = [
  { name: 'alpha-widget', tier: 'platinum', replicas: 7, phase: 'Serving' },
  { name: 'beta-widget', tier: 'bronze', replicas: 3, phase: 'Degraded' },
  { name: 'gamma-widget', tier: 'silver', replicas: 11, phase: 'Paused' },
];

/**
 * A CRD with its own additionalPrinterColumns and no status subresource.
 *
 * No subresource on purpose: without one the API server keeps a `status` block
 * written by a plain apply, so the fixture needs no second patch call and no
 * controller. The point is a kind Radar has no curated renderer for, whose
 * columns therefore have to come from the CRD itself.
 */
const CRD_YAML = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${CRD_NAME}
spec:
  group: ${GROUP}
  scope: Namespaced
  names:
    plural: ${PLURAL}
    singular: widget
    kind: ${KIND}
    listKind: WidgetList
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                tier:
                  type: string
                replicas:
                  type: integer
            status:
              type: object
              properties:
                phase:
                  type: string
      additionalPrinterColumns:
        - name: Tier
          type: string
          jsonPath: .spec.tier
        - name: Replicas
          type: integer
          jsonPath: .spec.replicas
        - name: Phase
          type: string
          jsonPath: .status.phase
`;

function widgetYaml(w: (typeof WIDGETS)[number]): string {
  return `
apiVersion: ${GROUP}/v1
kind: ${KIND}
metadata:
  name: ${w.name}
  namespace: ${NS}
spec:
  tier: ${w.tier}
  replicas: ${w.replicas}
status:
  phase: ${w.phase}
`;
}

/**
 * Read-only access to the fixture group for radar's own ServiceAccount.
 *
 * radar's chart grants CRD reads PER API GROUP - `rbac.crdGroups.*`, with
 * `all` defaulting to false and `additionalCrdGroups` provided for anything
 * not on the built-in list. K8s RBAC has no apiGroup wildcard, so a group
 * nobody has granted is simply invisible to radar: it lists nothing, and the
 * kind never reaches the UI.
 *
 * The first run of this spec failed exactly there, which is worth keeping in
 * the comment: without this grant the spec is not testing rendering, it is
 * testing whether an ungranted group appears, and the answer is always no.
 * Granting it is also the real operator path for a custom CRD.
 */
function rbacYaml(serviceAccount: string, namespace: string): string {
  return `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${RBAC_NAME}
rules:
  - apiGroups: ["${GROUP}"]
    resources: ["*"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${RBAC_NAME}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${RBAC_NAME}
subjects:
  - kind: ServiceAccount
    name: ${serviceAccount}
    namespace: ${namespace}
`;
}

/**
 * kubectl apply with the manifest on stdin, so no file is written to disk.
 *
 * helpers.kubectl() passes args only and has no stdin channel, so this calls
 * execFileSync directly rather than widening the shared helper for one caller.
 */
function applyViaStdin(yaml: string): string {
  return execFileSync('kubectl', ['apply', '-f', '-'], {
    input: yaml,
    encoding: 'utf8',
    env: process.env,
  }).trim();
}

/** What the cluster says a Widget's printer-column values are, right now. */
function widgetFromCluster(name: string): { tier: string; replicas: string; phase: string } {
  const raw = kubectl('get', PLURAL, name, '-n', NS, '-o', 'json');
  const obj = JSON.parse(raw) as {
    spec?: { tier?: string; replicas?: number };
    status?: { phase?: string };
  };
  return {
    tier: String(obj.spec?.tier ?? ''),
    replicas: String(obj.spec?.replicas ?? ''),
    phase: String(obj.status?.phase ?? ''),
  };
}

/** Every "<Kind> <count>" pair the Resources sidebar is advertising. */
async function sidebarCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const found: Record<string, number> = {};
    for (const el of document.querySelectorAll('button')) {
      if (el.querySelector('button')) continue;
      const m = (el.innerText || '').trim().match(/^([A-Z][A-Za-z]+)\n(\d+)$/);
      if (m) found[m[1]] = Number(m[2]);
    }
    return found;
  });
}

async function openResources(page: Page) {
  await gotoWhenNotRateLimited(page, '/resources');
  await expect
    .poll(async () => Object.keys(await sidebarCounts(page)).length, {
      message: 'the Resources page never listed any kinds, so custom resources cannot be checked',
      timeout: 90_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeGreaterThan(3);
}

/**
 * What the resource table is actually showing, for failure messages.
 *
 * Without this a locator that matches nothing reports only "expected > 0",
 * which is what turned the first two attempts at this spec into guesswork.
 */
async function tableSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('thead th'), (th) =>
      (th as HTMLElement).innerText.trim(),
    ).filter(Boolean);
    const rows = Array.from(document.querySelectorAll('tbody tr'), (tr) =>
      (tr as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    ).slice(0, 5);
    return `columns: [${headers.join(' | ')}] rows: ${rows.length ? rows.join(' // ') : '(none)'}`;
  });
}

/**
 * Click into the Widget kind and wait for its rows.
 *
 * The sidebar entry's text is "Widget\n3" and the newline is normalised to a
 * space in the accessible name, so the name regex has to allow whitespace
 * rather than anchor on the newline - resource-inventory.spec.ts carries the
 * same note, and ignoring it is how the first attempt here hung on a locator
 * that matched nothing.
 */
async function openWidgetKind(page: Page) {
  await openResources(page);

  // Narrow the sidebar with its own kind filter before clicking.
  //
  // Not a convenience: the sidebar groups kinds by API group under headers
  // that overlap the list while scrolling, and clicking an entry further down
  // fails with the header intercepting the pointer - "Dynamic Resource
  // Allocation ... subtree intercepts pointer events", which cost this spec a
  // full CI round. Filtering first is also what a person does to find one kind
  // among a hundred, and the input carries the same placeholder on both the
  // build from main and the published release.
  const kindFilter = page.getByPlaceholder('Filter resources...').first();
  await expect(kindFilter, 'the Resources sidebar has no kind filter').toBeVisible({ timeout: 30_000 });
  await kindFilter.fill(KIND);

  const entry = page.getByRole('button', { name: new RegExp(`^${KIND}\\s+\\d+$`) }).first();
  await expect(
    entry,
    `the Resources sidebar never offered the ${KIND} kind, so Radar is not surfacing a CRD it has no curated renderer for`,
  ).toBeVisible({ timeout: 45_000 });
  await entry.click();

  await expect
    .poll(async () => page.locator('tbody tr').count(), {
      message: `selecting ${KIND} never rendered any rows`,
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(0);
}

/** Narrow the table to one object, the way resource-inventory.spec.ts does. */
async function searchFor(page: Page, name: string) {
  const search = page.getByPlaceholder('Search... (press /)').first();
  await expect(search, 'the resource table has no search box').toBeVisible({ timeout: 30_000 });
  await search.fill(name);
  await expect
    .poll(async () => page.locator('tbody tr').filter({ hasText: name }).count(), {
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBeGreaterThan(0)
    .catch(() => {});
}

test.beforeAll(() => {
  applyViaStdin(CRD_YAML);
  kubectl('wait', '--for=condition=Established', `crd/${CRD_NAME}`, '--timeout=60s');

  // Grant radar read access to the fixture group. Read the ServiceAccount and
  // namespace off the running deployment rather than hardcoding them - the
  // chart templates both names.
  const sa = kubectl(
    '-n', 'radar', 'get', 'deployment/radar',
    '-o', 'jsonpath={.spec.template.spec.serviceAccountName}',
  ).trim();
  if (!sa) throw new Error('could not read radar\'s ServiceAccount from deployment/radar');
  applyViaStdin(rbacYaml(sa, 'radar'));

  // Start from a clean namespace. A previous attempt in this same worker may
  // have left one Terminating - afterAll deletes without waiting - and
  // creating objects in a Terminating namespace fails with a NotFound that
  // reads like the fixture was never written.
  kubectl('delete', 'namespace', NS, '--ignore-not-found', '--wait=true', '--timeout=120s');
  kubectl('create', 'namespace', NS);

  for (const w of WIDGETS) applyViaStdin(widgetYaml(w));

  // radar discovers CRDs once, at startup, and picks up the new RBAC grant at
  // the same time. Without this restart the kind is invisible to it and every
  // assertion below fails for a reason that has nothing to do with rendering.
  kubectl('-n', 'radar', 'rollout', 'restart', 'deployment/radar');
  kubectl('-n', 'radar', 'rollout', 'status', 'deployment/radar', '--timeout=180s');
});

test.afterAll(() => {
  // Leave the cluster as it was found. This scenario owns its cluster in CI,
  // but the same specs run against a shared stack locally.
  try {
    kubectl('delete', 'namespace', NS, '--ignore-not-found', '--wait=false');
    kubectl('delete', 'crd', CRD_NAME, '--ignore-not-found', '--wait=false');
    kubectl('delete', 'clusterrolebinding', RBAC_NAME, '--ignore-not-found', '--wait=false');
    kubectl('delete', 'clusterrole', RBAC_NAME, '--ignore-not-found', '--wait=false');
  } catch {
    // Teardown must not turn a green run red.
  }
});

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('a CRD Radar has no curated renderer for is still listed and counted', async ({ page }, testInfo) => {
  const expected = kubectl('get', PLURAL, '-A', '--no-headers', '-o', 'name').split('\n').filter(Boolean).length;
  expect(expected, 'the fixture Widgets are missing from the cluster').toBe(WIDGETS.length);

  await openResources(page);

  await expect
    .poll(async () => (await sidebarCounts(page))[KIND] ?? null, {
      message: `the Resources sidebar never advertised a ${KIND} count. An installed CRD that the product cannot see is indistinguishable, to a user, from an operator that is not working`,
      timeout: 90_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(expected);

  await captureSurface(page, testInfo, 'crd-kind-listed');
});

test('selecting the custom kind lists exactly the objects the cluster has', async ({ page }, testInfo) => {
  await openWidgetKind(page);

  const expected = kubectl('get', PLURAL, '-n', NS, '-o', 'name')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('/').pop() as string)
    .sort();
  expect(expected.length, `${NS} has no Widgets to check against`).toBe(WIDGETS.length);

  for (const name of expected) {
    await searchFor(page, name);
    const listed = await page.locator('tbody tr').filter({ hasText: name }).count();
    expect
      .soft(
        listed,
        `${NS}/${name} is a ${KIND} in this cluster but the Resources table does not list it. A list that silently drops custom resources reads as "the operator created nothing". On screen: ${await tableSnapshot(page)}`,
      )
      .toBeGreaterThan(0);
  }

  await captureSurface(page, testInfo, 'crd-objects-listed');
});

test("a custom kind renders its own printer columns, with the API server's values", async ({ page }, testInfo) => {
  await openWidgetKind(page);

  // 1. The columns the CRD declares are the columns on screen. Radar has no
  //    curated opinion about this kind, so these can only have come from the
  //    CRD's own additionalPrinterColumns.
  const headers = (
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('thead th'), (th) => (th as HTMLElement).innerText.trim()),
    )
  ).map((h) => h.toLowerCase());

  for (const column of ['Tier', 'Replicas', 'Phase']) {
    expect
      .soft(
        headers.some((h) => h.includes(column.toLowerCase())),
        `the ${KIND} table has no "${column}" column, though the CRD declares one in additionalPrinterColumns. Radar is falling back to a generic shape and dropping what the CRD says matters about itself. Columns on screen: ${headers.join(', ')}`,
      )
      .toBe(true);
  }

  // 2. Each row carries THAT object's values, read from the cluster now.
  //    Distinct tiers, replica counts and phases mean a row that borrowed
  //    another object's value cannot pass.
  for (const widget of WIDGETS) {
    const truth = widgetFromCluster(widget.name);
    await searchFor(page, widget.name);
    const row = page.locator('tbody tr').filter({ hasText: widget.name }).first();

    await expect(
      row,
      `no row for ${widget.name}. On screen: ${await tableSnapshot(page)}`,
    ).toBeVisible({ timeout: 30_000 });
    const text = ((await row.innerText()) ?? '').replace(/\s+/g, ' ');

    expect
      .soft(text, `the ${widget.name} row does not show its tier "${truth.tier}" - row reads: ${text}`)
      .toContain(truth.tier);
    expect
      .soft(
        text,
        `the ${widget.name} row does not show its replica count "${truth.replicas}" - row reads: ${text}`,
      )
      .toContain(truth.replicas);
    expect
      .soft(
        text,
        `the ${widget.name} row does not show its status phase "${truth.phase}". A custom resource whose status is missing from the list is the shape of every "shows the wrong state" bug filed against the CNPG, Velero and Kyverno surfaces - row reads: ${text}`,
      )
      .toContain(truth.phase);
  }

  await captureSurface(page, testInfo, 'crd-printer-columns');
});
