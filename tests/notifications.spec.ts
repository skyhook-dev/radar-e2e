import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, clusterId, gotoWhenNotRateLimited } from './helpers';

// The notification inbox behind the bell.
//
// This checks the inbox as a MECHANISM - the count, the attribution, the panel
// and clearing it - and deliberately does not require anything to be waiting in
// it. Two things make that premise unsafe:
//
//   - GET /api/orgs/{id}/inbox returns UNREAD items only, so anything that
//     marks them read empties it, including the second test in this file.
//   - An alert rule's first poll of a cluster is a BASELINE: whatever is
//     already broken is recorded without notifying. On a cluster created
//     minutes ago, every fixture issue is baselined, so an empty inbox there is
//     correct behaviour, not a missed notification.
//
// A test asserting "this cluster has issues, so the inbox must have something"
// therefore fails on a healthy product - it did, on a fresh CI cluster, twice.
// Proving that a notification is actually raised needs an issue created AFTER
// the baseline, which is what journey-broken-workload does; the lifecycle
// assertions live there.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);
test.describe.configure({ mode: 'serial' });

type InboxItem = {
  id: number;
  kind: string;
  metadata?: { cluster_id?: string; cluster_name?: string; issue_severity?: string };
};

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

function bell(page: Page) {
  return page.getByRole('button', { name: /Notifications/i }).first();
}

/** The unread count the bell advertises in its accessible name. */
async function unreadCount(page: Page): Promise<number> {
  const label = (await bell(page).getAttribute('aria-label')) ?? '';
  const m = label.match(/(\d+)\s*unread/i);
  return m ? Number(m[1]) : 0;
}

/** Unread notifications, as the API has them. */
async function inboxItems(page: Page): Promise<InboxItem[]> {
  return page
    .evaluate(async () => {
      const orgsRes = await fetch('/api/orgs');
      if (!orgsRes.ok) return [];
      const orgs = await orgsRes.json();
      const org = Array.isArray(orgs) ? orgs[0] : (orgs.orgs ?? [])[0];
      if (!org?.id) return [];
      const res = await fetch(`/api/orgs/${org.id}/inbox`);
      if (!res.ok) return [];
      const body = await res.json();
      return body.items ?? body.notifications ?? [];
    })
    .catch(() => []);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await gotoWhenNotRateLimited(page, '/');
});

test('the bell agrees with the inbox, and every notification says which cluster it is about', async ({
  page,
}, testInfo) => {
  const items = await inboxItems(page);
  const shown = await unreadCount(page);

  // The two have to tell the same story, but not the same number: the inbox
  // endpoint returns a PAGE (50 items here) while the bell counts every unread
  // one, so 117 on the bell against 50 from the API is correct. What would be
  // wrong is a bell claiming unread notifications that the inbox does not have,
  // which sends people looking for a problem that is not there.
  if (items.length > 0) {
    expect
      .soft(shown, `the inbox holds ${items.length} unread notification(s) but the bell advertises ${shown}`)
      .toBeGreaterThanOrEqual(items.length);
  } else {
    expect
      .soft(shown, `the bell advertises ${shown} unread notification(s) while the inbox holds none`)
      .toBe(0);
  }

  for (const item of items.slice(0, 5)) {
    expect
      .soft(
        item.metadata?.cluster_id,
        `a ${item.kind} notification does not say which cluster it came from - unactionable in a fleet`,
      )
      .toBe(clusterId);
  }

  // The panel has to open and show what the API holds.
  await bell(page).click();
  await expect
    .poll(async () => (await bodyText(page)).includes('Mark all read'), {
      message: 'the notification panel does not open, or offers no way to clear it',
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(true);

  const clusterName = items.find((i) => i.metadata?.cluster_name)?.metadata?.cluster_name;
  if (clusterName) {
    expect
      .soft(await bodyText(page), `the panel never names the cluster (${clusterName}) its notifications came from`)
      .toContain(clusterName);
  }

  await captureSurface(page, testInfo, 'notifications-inbox');
});

test('marking every notification read clears the count', async ({ page }) => {
  const before = await unreadCount(page);
  test.skip(before === 0, 'nothing is unread - on a cluster this young that is expected, not a failure');

  await bell(page).click();
  const markAll = page.getByRole('button', { name: /Mark all read/i }).first();
  await expect(markAll, 'the inbox offers no way to clear the unread count').toBeVisible({ timeout: 30_000 });
  await markAll.click();

  // Polled, not read once: a cluster that keeps breaking things can raise a new
  // notification between the click and the check. What has to be true is that
  // the backlog cleared, not that the number is frozen at zero.
  await expect
    .poll(async () => unreadCount(page), {
      message: `"Mark all read" left ${before} notification(s) unread - the count cannot be cleared`,
      timeout: 60_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeLessThan(before);
});
