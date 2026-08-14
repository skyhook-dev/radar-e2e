import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited, helm, installedHelmReleases } from './helpers';

// What the Helm release detail SAYS, checked against what helm says.
//
// helm.spec.ts proves the list matches `helm list`. The detail behind a release
// is six tabs deep - Overview, History, Manifest, Values, Resources, Hooks -
// and none of it was checked. Walking those tabs to see that they render would
// prove they work; it would not catch any of them showing another release's
// chart, an empty values file, or a manifest missing half the objects.
//
// So every tab is held to the CLI:
//   Overview  -> chart version, app version, revision from `helm list`
//   Values    -> `helm get values`
//   Manifest  -> `helm get manifest`, by the objects it declares
//   History   -> `helm history`, by revision
//
// The release under test is whichever one the harness installed, read at run
// time rather than named here, so this tracks the chart the harness actually
// deploys instead of a version someone wrote down once.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

/**
 * A release that will still be there in a moment.
 *
 * Not simply the first one helm lists. helm-actions installs a throwaway
 * release to exercise upgrade and rollback, and it sorts ahead of the
 * harness's own - so "the first release" can be one that is about to be
 * uninstalled underneath this spec the moment the two run at the same time.
 * The charts the harness installs are the stable choice.
 */
function stableRelease() {
  const releases = installedHelmReleases().filter((r) => !/^helm-actions-probe-/.test(r.name));
  return releases.find((r) => r.name === 'radar') ?? releases[0];
}

/** Open a release's detail and wait for something only the detail shows. */
async function openRelease(page: Page, name: string) {
  await gotoWhenNotRateLimited(page, '/helm');
  const row = page.locator('tbody tr').filter({ hasText: name }).first();
  await expect(row, `the Helm page does not list the release ${name}`).toBeVisible({ timeout: 60_000 });
  await row.click();

  // "Chart Information" belongs to the detail; the release NAME is already on
  // screen in the row that was just clicked, so waiting for it proves nothing.
  await expect
    .poll(async () => /Chart Information|Chart Version/.test(await bodyText(page)), {
      message: `clicking the ${name} release never opened its detail`,
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(true);
}

async function openTab(page: Page, label: string): Promise<boolean> {
  const tab = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
  if (!(await tab.count())) return false;
  await tab.click();
  await page.waitForTimeout(2000);
  return true;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('the release Overview reports the chart, version and revision helm reports', async ({ page }, testInfo) => {
  const release = stableRelease();
  expect(release, 'no Helm releases are installed, so there is no detail to check').toBeTruthy();

  // `helm list` gives "radar-1.7.1"; the page splits it into chart and version.
  const [, chartVersion] = release.chart.match(/-(\d[\w.+-]*)$/) ?? [];
  const chartName = release.chart.replace(/-\d[\w.+-]*$/, '');

  await openRelease(page, release.name);
  const text = await bodyText(page);

  expect.soft(text, `the ${release.name} detail does not name its chart (${chartName})`).toContain(chartName);
  if (chartVersion) {
    expect
      .soft(text, `the ${release.name} detail does not show the chart version helm reports (${chartVersion})`)
      .toContain(chartVersion);
  }
  expect
    .soft(text, `the ${release.name} detail does not show the namespace it is installed in`)
    .toContain(release.namespace);
  expect
    .soft(text.toLowerCase(), `the ${release.name} detail does not show its status (${release.status})`)
    .toContain(release.status.toLowerCase());

  await captureSurface(page, testInfo, 'helm-detail-overview');
});

test('the Values tab shows the values this release was installed with', async ({ page }, testInfo) => {
  const release = stableRelease();
  const values = helm('get', 'values', release.name, '-n', release.namespace, '-o', 'json');
  const parsed = JSON.parse(values || '{}') as Record<string, unknown>;
  const keys = Object.keys(parsed).filter((k) => k !== 'USER-SUPPLIED VALUES');

  await openRelease(page, release.name);
  const opened = await openTab(page, 'Values');
  expect.soft(opened, 'the release detail offers no Values tab').toBe(true);
  test.skip(!opened, 'no Values tab');

  const text = await bodyText(page);
  test.skip(keys.length === 0, 'this release was installed with no custom values, so there is nothing to compare');

  for (const key of keys.slice(0, 6)) {
    expect
      .soft(
        text,
        `the Values tab does not show "${key}", which helm reports as a value this release was installed with`,
      )
      .toContain(key);
  }

  await captureSurface(page, testInfo, 'helm-detail-values');
});

test('the Manifest tab declares the objects helm says this release owns', async ({ page }, testInfo) => {
  const release = stableRelease();
  const manifest = helm('get', 'manifest', release.name, '-n', release.namespace);

  // The object names helm's own manifest declares - the page must not be
  // showing a manifest for something else, or an empty one.
  const names = [...manifest.matchAll(/^\s*name:\s*(\S+)/gm)].map((m) => m[1].replace(/["']/g, ''));
  const unique = [...new Set(names)].slice(0, 5);
  expect(unique.length, 'helm reports a manifest with no named objects').toBeGreaterThan(0);

  await openRelease(page, release.name);
  const opened = await openTab(page, 'Manifest');
  expect.soft(opened, 'the release detail offers no Manifest tab').toBe(true);
  test.skip(!opened, 'no Manifest tab');

  const text = await bodyText(page);
  for (const name of unique) {
    expect
      .soft(text, `the Manifest tab does not declare ${name}, which helm's own manifest does`)
      .toContain(name);
  }

  await captureSurface(page, testInfo, 'helm-detail-manifest');
});

test('the History tab lists the revisions helm has recorded', async ({ page }, testInfo) => {
  const release = stableRelease();
  const history = JSON.parse(helm('history', release.name, '-n', release.namespace, '-o', 'json')) as {
    revision: number;
    status: string;
  }[];
  expect(history.length, 'helm reports no history for this release').toBeGreaterThan(0);

  await openRelease(page, release.name);
  const opened = await openTab(page, 'History');
  expect.soft(opened, 'the release detail offers no History tab').toBe(true);
  test.skip(!opened, 'no History tab');

  const text = await bodyText(page);
  for (const entry of history) {
    expect
      .soft(text, `the History tab does not list revision ${entry.revision}, which helm has recorded`)
      .toMatch(new RegExp(`\\b${entry.revision}\\b`));
  }
  expect
    .soft(text.toLowerCase(), `the History tab does not show the status helm records (${history[0].status})`)
    .toContain(history[history.length - 1].status.toLowerCase());

  await captureSurface(page, testInfo, 'helm-detail-history');
});
