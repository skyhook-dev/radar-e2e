import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited, kubectl } from './helpers';

// The YAML view - the surface people open when they stop trusting the others.
//
// Every other panel summarises. This one claims to be the object itself, which
// makes it both the most trusted thing in the product and the easiest to get
// subtly wrong: a stale copy, a different revision, or the right fields from
// the wrong object all render perfectly.
//
// So it is compared with `kubectl get -o json` on the fields that identify an
// object beyond doubt - the uid above all, which no other object in the
// cluster shares - plus the ones an operator reads it for: image, node,
// resourceVersion.
//
// The negative half matters as much: the YAML must NOT contain a different
// object's uid. A view that renders the last object you looked at is exactly
// the bug this catches, and it cannot be caught by checking that fields are
// present.
//
// Read off the running product before being written: the YAML pane loads
// asynchronously behind a "Loading…" placeholder, so it has to be waited for
// by content rather than by the tab becoming selected.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

const FIXTURE_NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';

type K8sObject = {
  metadata: { name: string; namespace: string; uid: string; resourceVersion: string };
  spec?: { nodeName?: string; containers?: { image: string }[]; template?: { spec: { containers: { image: string }[] } } };
};

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

async function openDetail(page: Page, kindLabel: string, name: string) {
  await gotoWhenNotRateLimited(page, '/resources');

  const kindButton = page.getByRole('button', { name: new RegExp(`^${kindLabel}\\s+\\d+$`) }).first();
  if (await kindButton.count()) {
    await kindButton.click();
    await page.waitForTimeout(1500);
  }

  const search = page.getByPlaceholder('Search... (press /)').first();
  await expect(search, 'the resource table has no search box').toBeVisible({ timeout: 45_000 });
  await search.fill(name);

  const row = page.locator('tbody tr').filter({ hasText: name }).first();
  await expect(row, `the Resources table does not list ${FIXTURE_NS}/${name}`).toBeVisible({ timeout: 45_000 });
  await row.click();

  await expect
    .poll(async () => /Metadata|Pod Template|Related Resources|YAML/.test(await bodyText(page)), {
      message: `clicking ${name} never opened a detail view`,
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(true);
}

/** Open the YAML pane and wait for the document itself, not the placeholder. */
async function openYaml(page: Page, name: string): Promise<string> {
  const yamlButton = page.getByRole('button', { name: /^YAML$/i }).first();
  await expect(yamlButton, `the detail for ${name} offers no YAML view`).toBeVisible({ timeout: 30_000 });
  await yamlButton.click();

  await expect
    .poll(async () => /apiVersion:|kind:\s*\w+/.test(await bodyText(page)), {
      message: `the YAML view for ${name} never loaded a document - it stayed on its placeholder`,
      timeout: 60_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(true);

  return bodyText(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('the YAML for a pod is that pod, down to its uid', async ({ page }, testInfo) => {
  const pods = JSON.parse(kubectl('get', 'pods', '-n', FIXTURE_NS, '-l', 'app=chatty', '-o', 'json')) as {
    items: K8sObject[];
  };
  const pod = pods.items[0];
  expect(pod, `no chatty pod in ${FIXTURE_NS} to read`).toBeTruthy();

  await openDetail(page, 'Pod', pod.metadata.name);
  const yaml = await openYaml(page, pod.metadata.name);

  // The uid is the whole point: it identifies this object and nothing else in
  // the cluster, now or ever.
  expect
    .soft(yaml, `the YAML shown for ${pod.metadata.name} does not carry its uid (${pod.metadata.uid})`)
    .toContain(pod.metadata.uid);
  expect.soft(yaml, 'the YAML does not name the pod it is meant to be').toContain(pod.metadata.name);
  expect.soft(yaml, 'the YAML does not carry the namespace the pod is in').toContain(pod.metadata.namespace);

  if (pod.spec?.nodeName) {
    expect
      .soft(yaml, `the YAML does not say which node the pod runs on (${pod.spec.nodeName})`)
      .toContain(pod.spec.nodeName);
  }
  if (pod.spec?.containers?.[0]?.image) {
    expect
      .soft(yaml, `the YAML does not carry the image the pod runs (${pod.spec.containers[0].image})`)
      .toContain(pod.spec.containers[0].image);
  }

  // And it must not be another object's document. Every other pod in the
  // namespace is a candidate for the wrong-object bug.
  const others = (JSON.parse(kubectl('get', 'pods', '-n', FIXTURE_NS, '-o', 'json')) as { items: K8sObject[] }).items
    .filter((p) => p.metadata.uid !== pod.metadata.uid)
    .slice(0, 4);
  for (const other of others) {
    expect
      .soft(
        yaml,
        `the YAML shown for ${pod.metadata.name} also contains ${other.metadata.name}'s uid - it is not one object's document`,
      )
      .not.toContain(other.metadata.uid);
  }

  await captureSurface(page, testInfo, 'yaml-pod');
});

test('the YAML for a deployment is that deployment, and moves when the cluster does', async ({ page }, testInfo) => {
  const name = 'storefront';
  const before = JSON.parse(kubectl('get', 'deployment', name, '-n', FIXTURE_NS, '-o', 'json')) as K8sObject;

  await openDetail(page, 'Deployment', name);
  const yaml = await openYaml(page, name);

  expect
    .soft(yaml, `the YAML shown for ${name} does not carry its uid (${before.metadata.uid})`)
    .toContain(before.metadata.uid);
  expect
    .soft(yaml, `the YAML does not carry the image ${name} runs`)
    .toContain(before.spec?.template?.spec.containers[0].image ?? '');

  // A YAML view that is a snapshot taken once is worse than none: it looks
  // authoritative and quietly ages. Annotating the deployment changes its
  // resourceVersion, which the document must follow.
  const marker = `e2e-yaml-check-${Date.now()}`;
  kubectl('annotate', 'deployment', name, '-n', FIXTURE_NS, `e2e-check=${marker}`, '--overwrite');

  try {
    await expect
      .poll(
        async () => {
          await gotoWhenNotRateLimited(page, '/resources');
          await openDetail(page, 'Deployment', name);
          return openYaml(page, name);
        },
        {
          message:
            `${FIXTURE_NS}/${name} was annotated in the cluster but its YAML view never showed the change - ` +
            `the document is a snapshot, not the object`,
          timeout: 180_000,
          intervals: [5000, 10_000],
        },
      )
      .toContain(marker);
  } finally {
    kubectl('annotate', 'deployment', name, '-n', FIXTURE_NS, 'e2e-check-', '--overwrite');
  }

  await captureSurface(page, testInfo, 'yaml-deployment');
});
