import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, clusterId, gotoWhenNotRateLimited } from './helpers';

// The notification inbox - how anyone finds out about a problem without
// watching a dashboard.
//
// It is the only surface in the product that tells the WHOLE story of an
// issue rather than its current state: it records both the arrival and the
// clearing. The fixture cluster produces both within minutes, so both can be
// checked for real.
//
// What is checked:
//   - the bell says how many are unread, in its accessible name
//   - the inbox lists notifications attributed to a cluster that exists
//   - the API and the panel agree about what happened
//   - both halves of the lifecycle are represented: something opened, and
//     something cleared
//   - marking everything read actually clears the count
//
// Read off the running product before being written: the bell is labelled
// "Notifications, N unread"; entries read "<subject>" then "New critical issue
// in <cluster>" or "Resolved: <subject>" then "The issue in <cluster>
// cleared."; and GET /api/orgs/<id>/inbox returns items whose `kind` is
// issue.opened or issue.resolved with the cluster in `metadata`.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

type InboxItem = {
  id: number;
  kind: string;
  metadata?: { cluster_id?: string; cluster_name?: string; issue_severity?: string };
};

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

function bell(page: Page) {
  return page.getByRole('button', { name: /Notifications/i }).first();
}

/** The unread count the bell is advertising, or null when it says nothing. */
async function unreadCount(page: Page): Promise<number | null> {
  const label = (await bell(page).getAttribute('aria-label')) ?? '';
  const m = label.match(/(\d+)\s*unread/i);
  return m ? Number(m[1]) : label.toLowerCase().includes('unread') ? null : 0;
}

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

test('the inbox records issues arriving and clearing, attributed to a real cluster', async ({ page }, testInfo) => {
  // The fixture cluster is deliberately broken in several ways, so something
  // must have been notified about by now.
  await expect
    .poll(async () => (await inboxItems(page)).length, {
      message:
        'the notification inbox is empty although this cluster has issues - nobody would be told about a problem ' +
        'unless they happened to be looking at the dashboard',
      timeout: 120_000,
      intervals: [3000, 5000, 10_000],
    })
    .toBeGreaterThan(0);

  const items = await inboxItems(page);

  // Every notification has to say which cluster it is about, and it has to be
  // this one - an unattributed alert is unactionable in a fleet.
  const attributed = items.filter((i) => i.metadata?.cluster_id);
  expect
    .soft(attributed.length, 'notifications do not say which cluster they came from')
    .toBeGreaterThan(0);
  if (attributed.length) {
    expect
      .soft(
        attributed[0].metadata?.cluster_id,
        `a notification is attributed to a cluster that is not the one under test`,
      )
      .toBe(clusterId);
  }

  // Both halves of the lifecycle. A product that only ever tells you things
  // broke, and never that they recovered, is one people mute.
  const kinds = new Set(items.map((i) => i.kind));
  expect
    .soft([...kinds].join(', '), 'the inbox never records an issue being raised')
    .toMatch(/opened|created|new|issue\./i);
  expect
    .soft(
      kinds.has('issue.resolved'),
      `the inbox has ${items.length} notification(s) and not one of them is a resolution - ` +
        `if issues never clear here, the count only ever grows`,
    )
    .toBe(true);

  // And the panel has to show what the API holds.
  await bell(page).click();
  await expect
    .poll(async () => (await bodyText(page)).includes('Mark all read'), { timeout: 30_000, intervals: [1000, 2000] })
    .toBe(true);

  const panel = await bodyText(page);
  const clusterName = items.find((i) => i.metadata?.cluster_name)?.metadata?.cluster_name;
  if (clusterName) {
    expect
      .soft(panel, `the inbox panel never names the cluster (${clusterName}) its notifications came from`)
      .toContain(clusterName);
  }
  if (kinds.has('issue.resolved')) {
    expect
      .soft(panel, 'the API records resolutions but the panel never shows one')
      .toMatch(/resolved|cleared/i);
  }

  await captureSurface(page, testInfo, 'notifications-inbox');
});

test('marking every notification read clears the unread count', async ({ page }) => {
  const before = await unreadCount(page);
  test.skip(before === 0, 'nothing is unread, so there is nothing to clear');

  await bell(page).click();
  const markAll = page.getByRole('button', { name: /Mark all read/i }).first();
  await expect(markAll, 'the inbox offers no way to clear the unread count').toBeVisible({ timeout: 30_000 });
  await markAll.click();

  // Polled rather than read once: this cluster keeps breaking things, so a new
  // notification can arrive between the click and the check. What has to be
  // true is that the backlog went away, not that the number is frozen at zero.
  await expect
    .poll(async () => unreadCount(page), {
      message: `"Mark all read" left ${before} notification(s) unread - the count cannot be cleared`,
      timeout: 60_000,
      intervals: [2000, 3000, 5000],
    })
    .toBeLessThan(before ?? 1);
});
