import { test, expect } from '@playwright/test';
import { assertClusterConnected, clusterId, installedHelmReleases } from './helpers';

// Second sanity scenario, deliberately on a different code path from the
// timeline: Helm release data is read out of the cluster by radar (release
// records live in Kubernetes Secrets, behind their own RBAC) and travels back
// through the tunnel to the hub. A broken timeline and broken Helm reads have
// nothing in common, so one passing tells you little about the other.
//
// The expected releases come from `helm list` against the same cluster rather
// than from a fixture: the harness installs radar-hub and radar, so whatever
// helm reports is the truth the UI has to match.

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
});

test('the Helm page lists the releases installed in the cluster', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  const expected = installedHelmReleases();
  expect(expected.length, 'no Helm releases in the cluster - the harness installs two').toBeGreaterThan(0);

  await page.goto(`/c/${clusterId}/helm`);

  // Wait for the release table rather than a spinner: an empty table and a
  // still-loading one look identical in a screenshot.
  const table = page.getByRole('table').first();
  await expect(table).toBeVisible();

  for (const release of expected) {
    const row = table.getByRole('row').filter({ hasText: release.name });
    await expect(row.first(), `no Helm row for release "${release.name}"`).toBeVisible();
    // The chart column proves the row carries real release data rather than
    // just a name echoed from somewhere else.
    await expect(
      row.first(),
      `release "${release.name}" is missing its chart version ${release.chart}`,
    ).toContainText(release.chart);
  }

  await testInfo.attach('helm-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('a release reports the status Helm reports', async ({ page }) => {
  // Status is the field an operator scans first; if the hub renders every
  // release as "unknown" the page still looks populated and still lies.
  await page.goto('/');
  const [release] = installedHelmReleases();

  await page.goto(`/c/${clusterId}/helm`);
  const row = page.getByRole('table').first().getByRole('row').filter({ hasText: release.name }).first();
  await expect(row).toBeVisible();
  await expect(row, `release "${release.name}" should read ${release.status}`).toContainText(
    release.status,
  );
});
