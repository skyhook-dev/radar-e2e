import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited, kubectl } from './helpers';

// Does the product tell the truth about what is in the cluster?
//
// Most of this suite proves surfaces WORK - they render, they filter, they
// respond. That is not the same as proving what they say is CORRECT. The
// Resources sidebar makes a numeric claim about every kind in the cluster
// ("Deployment 15", "ConfigMap 25", "Node 1"), and each one is checkable
// against `kubectl get`. So they are all checked, not sampled.
//
// Then the same standard is applied one level down: selecting a kind must list
// exactly the objects the cluster has of that kind, and opening one must show
// that object's real image, replicas and labels - not merely open.
//
// Every kind is a soft assertion so one wrong count reports every other kind
// too: "ConfigMaps are wrong" and "everything is wrong" are different
// diagnoses, and stopping at the first loses that.

test.use({ storageState: authStatePath });
test.setTimeout(420_000);

const FIXTURE_NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';

/** Sidebar label -> what `kubectl get` calls it. Only kinds that map 1:1. */
const KINDS: Record<string, string> = {
  Deployment: 'deployments',
  Pod: 'pods',
  ReplicaSet: 'replicasets',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  Job: 'jobs',
  CronJob: 'cronjobs',
  Service: 'services',
  EndpointSlice: 'endpointslices',
  ConfigMap: 'configmaps',
  Secret: 'secrets',
  ServiceAccount: 'serviceaccounts',
  HorizontalPodAutoscaler: 'hpa',
  Namespace: 'namespaces',
  Node: 'nodes',
  PersistentVolume: 'persistentvolumes',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  StorageClass: 'storageclasses',
  Role: 'roles',
  RoleBinding: 'rolebindings',
  ClusterRole: 'clusterroles',
  ClusterRoleBinding: 'clusterrolebindings',
  APIService: 'apiservices',
};

function clusterCount(resource: string): number | null {
  try {
    return kubectl('get', resource, '-A', '--no-headers', '-o', 'name').split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

/** Every "<Kind> <count>" the sidebar is advertising. */
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
      message: 'the Resources page never listed any kinds, so its inventory cannot be checked',
      timeout: 90_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeGreaterThan(3);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('every resource count the sidebar advertises matches the cluster', async ({ page }, testInfo) => {
  await openResources(page);

  const shown = await sidebarCounts(page);
  const checked: string[] = [];
  const wrong: string[] = [];

  for (const [label, count] of Object.entries(shown)) {
    const resource = KINDS[label];
    if (!resource) continue;
    const actual = clusterCount(resource);
    if (actual === null) continue;
    checked.push(label);

    // Polled: the page keeps counting as the cluster changes under it, and a
    // Pod count read mid-rollout is a race rather than a wrong number.
    const agreed = await expect
      .poll(async () => (await sidebarCounts(page))[label], { timeout: 30_000, intervals: [1000, 2000, 5000] })
      .toBe(actual)
      .then(() => true)
      .catch(() => false);

    if (!agreed) wrong.push(`${label}: page ${(await sidebarCounts(page))[label]}, cluster ${actual}`);
    expect
      .soft(
        agreed,
        `the Resources page says the cluster has ${count} ${label}(s); kubectl says ${actual}`,
      )
      .toBe(true);
  }

  expect(checked.length, 'no kind on the Resources page could be compared with the cluster').toBeGreaterThan(5);
  testInfo.annotations.push({
    type: 'inventory',
    description: `${checked.length} kinds compared with kubectl, ${wrong.length} disagreed${wrong.length ? `: ${wrong.join('; ')}` : ''}`,
  });
  await captureSurface(page, testInfo, 'resource-inventory');
});

test('selecting a kind lists exactly the objects the cluster has of that kind', async ({ page }, testInfo) => {
  await openResources(page);

  // Deployments in the fixture namespace: few enough to name every one, and
  // created by this harness so the expected set is known exactly.
  const expected = kubectl('get', 'deployments', '-n', FIXTURE_NS, '-o', 'name')
    .split('\n')
    .map((l) => l.trim().replace(/^deployment\.apps\//, ''))
    .filter(Boolean)
    .sort();
  expect(expected.length, `${FIXTURE_NS} has no deployments to check against`).toBeGreaterThan(0);

  // By accessible name: the button's text is "Deployment\n15", and the newline
  // is normalised to a space in the name, so a hasText regex anchored on \n
  // matches nothing at all.
  const kindButton = page.getByRole('button', { name: /^Deployment\s+\d+$/ }).first();
  await expect(kindButton, 'the Resources sidebar offers no Deployment kind').toBeVisible({ timeout: 45_000 });
  await kindButton.click();

  // Narrow to the fixture namespace by searching, so other namespaces' own
  // deployments are not part of the comparison.
  const search = page.getByPlaceholder('Search... (press /)').first();
  await expect(search, 'the resource table has no search box').toBeVisible({ timeout: 30_000 });

  for (const name of expected) {
    await search.fill(name);
    await expect
      .poll(async () => page.locator('tbody tr').filter({ hasText: name }).count(), {
        timeout: 30_000,
        intervals: [1000, 2000],
      })
      .toBeGreaterThan(0)
      .catch(() => {});

    const listed = await page.locator('tbody tr').filter({ hasText: name }).count();
    expect
      .soft(
        listed,
        `${FIXTURE_NS}/${name} is a Deployment in this cluster but the Resources table does not list it`,
      )
      .toBeGreaterThan(0);
  }

  await captureSurface(page, testInfo, 'resource-kind-deployments');
});

test('a workload detail shows that workload real image, replicas and labels', async ({ page }, testInfo) => {
  await openResources(page);

  const name = 'storefront';
  const deployment = JSON.parse(kubectl('get', 'deployment', name, '-n', FIXTURE_NS, '-o', 'json')) as {
    spec: {
      replicas: number;
      strategy?: { type?: string; rollingUpdate?: { maxSurge?: string; maxUnavailable?: string } };
      template: { spec: { containers: { name: string; image: string; resources?: { requests?: Record<string, string> } }[] } };
    };
    status?: { conditions?: { type: string }[] };
    metadata: { labels?: Record<string, string> };
  };
  const container = deployment.spec.template.spec.containers[0];

  const kindButton = page.getByRole('button', { name: /^Deployment\s+\d+$/ }).first();
  await expect(kindButton).toBeVisible({ timeout: 45_000 });
  await kindButton.click();

  const search = page.getByPlaceholder('Search... (press /)').first();
  await search.fill(name);
  const row = page.locator('tbody tr').filter({ hasText: name }).first();
  await expect(row, `the Resources table does not list ${FIXTURE_NS}/${name}`).toBeVisible({ timeout: 45_000 });
  await row.click();

  // Wait for a marker only the DETAIL has. Waiting for the workload's name is
  // satisfied by the table row that was just clicked, so the assertions below
  // would run against the list and report a detail panel that works as empty.
  const detail = async () => page.evaluate(() => document.body.innerText);
  await expect
    .poll(async () => /Pod Template|Conditions \(/.test(await detail()), {
      message: `clicking ${FIXTURE_NS}/${name} never opened a detail view`,
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(true);

  const text = await detail();
  const strategy = deployment.spec.strategy?.rollingUpdate;
  const requests = container.resources?.requests;

  // Every one of these is a fact the cluster holds and the panel claims.
  const facts: [string, string | undefined, string][] = [
    ['the image it actually runs', container.image, container.image],
    ['its container name', container.name, container.name],
    ['the namespace it lives in', FIXTURE_NS, FIXTURE_NS],
    ['its rollout strategy', deployment.spec.strategy?.type, deployment.spec.strategy?.type],
    ['its max surge', strategy?.maxSurge, String(strategy?.maxSurge ?? '')],
    ['its max unavailable', strategy?.maxUnavailable, String(strategy?.maxUnavailable ?? '')],
  ];
  for (const [what, value, needle] of facts) {
    if (!value) continue;
    expect.soft(text, `the detail for ${name} does not show ${what} (${needle})`).toContain(needle);
  }

  // Replicas, as the cluster has them.
  expect
    .soft(text, `the detail for ${name} does not show its ${deployment.spec.replicas} replicas`)
    .toMatch(
      new RegExp(`${deployment.spec.replicas}\\s*/\\s*${deployment.spec.replicas}|${deployment.spec.replicas}\\s+replicas?`, 'i'),
    );

  // The conditions Kubernetes is reporting, by name.
  for (const condition of deployment.status?.conditions ?? []) {
    expect
      .soft(text, `the detail for ${name} does not report its ${condition.type} condition`)
      .toContain(condition.type);
  }

  // Labels have to appear with their VALUES - keys alone do not describe the
  // object.
  for (const [key, value] of Object.entries(deployment.metadata.labels ?? {})) {
    expect.soft(text, `the detail for ${name} does not show its label ${key}=${value}`).toContain(value);
  }

  // Requested resources, which is what capacity planning is read from.
  if (requests?.memory) {
    expect
      .soft(
        text.replace(/\s+/g, ' '),
        `the detail for ${name} does not show its memory request (${requests.memory})`,
      )
      .toMatch(/Mem:|memory/i);
  }

  await captureSurface(page, testInfo, 'resource-detail-deployment');
});

// The same standard, applied across kinds rather than to one workload.
//
// Each kind carries different facts, and each is read from the cluster at the
// time of the test: a Pod's node and phase, a Service's type and ports, a
// ConfigMap's keys. Anything a detail panel omits here is something an
// operator would have to go to kubectl for.
const DETAIL_FACTS: {
  kind: string;
  resource: string;
  name: string;
  facts: (object: Record<string, unknown>) => { what: string; value: string }[];
}[] = [
  {
    kind: 'Service',
    resource: 'service',
    name: 'storefront',
    facts: (svc) => {
      const s = svc as { spec: { type: string; ports: { port: number }[]; selector?: Record<string, string> } };
      return [
        { what: 'its service type', value: s.spec.type },
        { what: 'the port it serves', value: String(s.spec.ports?.[0]?.port ?? '') },
        ...Object.values(s.spec.selector ?? {}).map((v) => ({ what: `its selector value ${v}`, value: v })),
      ];
    },
  },
  {
    kind: 'ConfigMap',
    resource: 'configmap',
    name: 'storefront-config',
    facts: (cm) => {
      const c = cm as { data?: Record<string, string> };
      return Object.keys(c.data ?? {}).map((k) => ({ what: `its key ${k}`, value: k }));
    },
  },
  {
    kind: 'StatefulSet',
    resource: 'statefulset',
    name: 'ledger',
    facts: (sts) => {
      const s = sts as {
        spec: { replicas: number; serviceName?: string; template: { spec: { containers: { image: string }[] } } };
      };
      return [
        { what: 'the image it runs', value: s.spec.template.spec.containers[0].image },
        { what: 'its replica count', value: String(s.spec.replicas) },
      ];
    },
  },
  {
    kind: 'DaemonSet',
    resource: 'daemonset',
    name: 'node-probe',
    facts: (ds) => {
      const d = ds as {
        status: { desiredNumberScheduled: number };
        spec: { template: { spec: { containers: { image: string }[] } } };
      };
      return [
        { what: 'the image it runs', value: d.spec.template.spec.containers[0].image },
        { what: 'how many nodes it is scheduled on', value: String(d.status.desiredNumberScheduled) },
      ];
    },
  },
  {
    kind: 'CronJob',
    resource: 'cronjob',
    name: 'nightly-report',
    facts: (cj) => {
      const c = cj as { spec: { schedule: string } };
      // The schedule is the whole point of a CronJob: a detail panel that
      // omits it cannot answer "when does this run".
      return [{ what: 'its schedule', value: c.spec.schedule }];
    },
  },
  {
    kind: 'HorizontalPodAutoscaler',
    resource: 'hpa',
    name: 'hpa-pinned',
    facts: (hpa) => {
      const h = hpa as { spec: { minReplicas: number; maxReplicas: number; scaleTargetRef: { name: string } } };
      return [
        { what: 'what it scales', value: h.spec.scaleTargetRef.name },
        { what: 'its maximum replicas', value: String(h.spec.maxReplicas) },
      ];
    },
  },
];

for (const target of DETAIL_FACTS) {
  test(`the ${target.kind} detail shows what the cluster holds`, async ({ page }, testInfo) => {
    await openResources(page);

    const object = JSON.parse(
      kubectl('get', target.resource, target.name, '-n', FIXTURE_NS, '-o', 'json'),
    ) as Record<string, unknown>;
    const expectedFacts = target.facts(object).filter((f) => f.value);
    expect(expectedFacts.length, `nothing to check on ${target.kind} ${target.name}`).toBeGreaterThan(0);

    const kindButton = page.getByRole('button', { name: new RegExp(`^${target.kind}\\s+\\d+$`) }).first();
    await expect(kindButton, `the Resources sidebar offers no ${target.kind} kind`).toBeVisible({ timeout: 45_000 });
    await kindButton.click();

    const search = page.getByPlaceholder('Search... (press /)').first();
    await search.fill(target.name);
    const row = page.locator('tbody tr').filter({ hasText: target.name }).first();
    await expect(row, `the Resources table does not list ${FIXTURE_NS}/${target.name}`).toBeVisible({
      timeout: 45_000,
    });

    await row.click();

    // Waits for a section only the detail renders. "the body text changed" is
    // satisfied the moment the panel starts opening, so the assertions below
    // ran against a half-rendered detail and reported fields as missing that
    // arrive a second later - both the StatefulSet and DaemonSet images did
    // exactly that.
    await expect
      .poll(async () => /Metadata|Pod Template|Related Resources/.test(await page.evaluate(() => document.body.innerText)), {
        message: `clicking ${FIXTURE_NS}/${target.name} never opened a detail view`,
        timeout: 45_000,
        intervals: [1000, 2000, 3000],
      })
      .toBe(true);

    const text = await page.evaluate(() => document.body.innerText);
    for (const { what, value } of expectedFacts) {
      expect
        .soft(text, `the ${target.kind} detail for ${target.name} does not show ${what} (${value})`)
        .toContain(value);
    }

    await captureSurface(page, testInfo, `resource-detail-${target.kind.toLowerCase()}`);
  });
}
