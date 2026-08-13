import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface } from './helpers';

// The three mutating actions in the Issues domain: Mark seen, Snooze, Dismiss.
//
// Until now no test had ever used them. They are the only controls in the whole
// suite that change what the hub stores, and each one has a distinct promise
// attached to it, printed on the button itself:
//
//   Mark seen - "stays in Open, just dimmed so the team knows it's being looked at"
//   Snooze    - "hide from Open until a time you pick, then it returns automatically"
//   Dismiss   - "hide from Open for the whole org, with a reason. Stays hidden
//                until you undo it (or an optional expiry)"
//
// Each test holds the product to its own sentence, and then undoes the action
// through the UI - the undo is not cleanup bolted on, it is half the feature.
// A dismissal you cannot reverse is a trap, and all three states are stored
// server-side, so anything left behind changes what every later test and every
// other session signed in to this hub sees (see KNOWN-ISSUES.md).
//
// Read off the running product before being written: all three verbs post to
// /api/triage (ack / snooze / dismiss) and all three undos are
// DELETE /api/triage/{id}.
//
// Three things about this page that each produced a convincing false failure:
//
//  1. Every input[type=checkbox] on /issues is a filter facet in the right-hand
//     panel. There is NO row selection. "Tick the checkbox at index 1 to select
//     an issue" actually applies a Warning severity filter and narrows the list
//     to one row. The actions are icon buttons on every row and need no
//     selection at all.
//  2. These controls must be located as `button` ELEMENTS by aria-label, never
//     by role. They render inside the row, the row is a div[role=button], and
//     an accessible name is computed from descendants - so the row's own name
//     contains "Mark seen ...", "click to undo" and the rest. getByRole(
//     'button', {name: /click to undo/}).first() matches the ROW: it opens the
//     detail drawer, sends no request, and looks exactly like a product whose
//     undo does nothing.
//  3. Issues are not identified by their title. The fixture cluster carries
//     three broken HPAs, so "Autoscaling limited" is on three separate rows,
//     and resource names render truncated with an ellipsis. Movement is checked
//     by row count and by the record the hub actually stored, not by matching
//     row text.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const contentText = (page: Page) =>
  page.evaluate(() => {
    const nav = document.querySelector('nav,[aria-label="Primary navigation"]');
    const navText = nav ? nav.innerText : '';
    return navText ? document.body.innerText.split(navText).join(' ') : document.body.innerText;
  });

/** The number shown on a state tab, e.g. "Dismissed (2)" -> 2. */
async function tabCount(page: Page, tab: string): Promise<number> {
  const text = await contentText(page);
  const m = text.match(new RegExp(`${tab}\\s*\\((\\d+)\\)`, 'i'));
  return m ? Number(m[1]) : -1;
}

type TriageRecord = {
  id: string;
  verb: string;
  scope: { kind?: string; name?: string; namespace?: string };
};

/**
 * Every triage record the hub is currently holding, whatever created it.
 *
 * Both calls go through fetch() inside the page rather than page.request. The
 * hub rejects a triage DELETE that does not come from the app's own origin -
 * page.request.delete gets 403 where an in-page fetch gets 204 - so an
 * out-of-page cleanup silently leaves every record behind.
 */
async function triageRecords(page: Page): Promise<TriageRecord[]> {
  return page
    .evaluate(async () => {
      const res = await fetch('/api/triage');
      if (!res.ok) return [];
      return (await res.json()).records ?? [];
    })
    .catch(() => []);
}

/** Remove a triage record. Returns the status so a failed cleanup is visible. */
async function deleteTriageRecord(page: Page, id: string): Promise<number> {
  return page
    .evaluate(async (recordId) => (await fetch(`/api/triage/${recordId}`, { method: 'DELETE' })).status, id)
    .catch(() => 0);
}

/**
 * Rows in the currently shown queue.
 *
 * Anchored on the Dismiss button, which is present on every row in every
 * state. Mark seen is not: on a row that has been marked, that button is
 * REPLACED by the unmark button, so counting rows by their Mark seen button
 * reports 4 of 5 rows right after a successful mark and makes "stays in Open"
 * look broken when the issue is sitting there with a Seen badge on it.
 */
function issueRows(page: Page) {
  return page.locator('[role=button]').filter({ has: page.locator('button[aria-label^="Dismiss" i]') });
}

function describeScope(rec?: TriageRecord): string {
  if (!rec) return 'nothing';
  const s = rec.scope ?? {};
  return `${rec.verb} on ${s.kind ?? '?'} ${s.namespace ?? '?'}/${s.name ?? '?'}`;
}

async function openIssues(page: Page) {
  await page.goto('/issues');
  await expect
    .poll(async () => (await contentText(page)).length, {
      message: 'the Issues page never rendered',
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(200);
  await expect(issueRows(page).first(), 'the Issues list never rendered an issue with actions on it').toBeVisible({
    timeout: 45_000,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await openIssues(page);

  // Start from a queue nobody has touched. A record left by an earlier run
  // hides an issue, and every count in this file is relative.
  const stale = await triageRecords(page);
  if (stale.length) {
    for (const rec of stale) await deleteTriageRecord(page, rec.id);
    await openIssues(page);
  }
});

// Whatever the test did or failed to do, the hub goes back to how it was found.
// The UI undo is asserted inside each test; this is the safety net for the runs
// where an assertion fails before the undo is reached.
test.afterEach(async ({ page }) => {
  for (const rec of await triageRecords(page)) {
    const status = await deleteTriageRecord(page, rec.id);
    // Loud on purpose. A cleanup that quietly fails is worse than none: the
    // next test starts against a hub that is not in the state it assumes, and
    // the failure surfaces somewhere unrelated.
    expect
      .soft(
        status,
        `could not remove the ${rec.verb} left on the hub (record ${rec.id}) - later tests and other ` +
          `sessions will see it, and the next run starts from a queue that is missing issues`,
      )
      .toBe(204);
  }
});

test('marking an issue seen keeps it in Open, and the mark can be removed', async ({ page }, testInfo) => {
  const openBefore = await issueRows(page).count();
  const snoozedBefore = await tabCount(page, 'Snoozed');
  const dismissedBefore = await tabCount(page, 'Dismissed');

  await issueRows(page).first().locator('button[aria-label^="Mark seen" i]').first().click();

  // The hub has to have recorded it, and recorded it as an acknowledgement.
  await expect
    .poll(async () => (await triageRecords(page)).map((r) => r.verb), {
      message: 'marking an issue seen stored nothing on the hub, so no one else will see that it is being looked at',
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toEqual(['ack']);

  const [record] = await triageRecords(page);
  await expect
    .poll(async () => (await contentText(page)).includes('Seen by'), {
      message: `the hub recorded ${describeScope(record)} but the row shows no sign of it`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(true);

  // The promise on the button is that the issue STAYS in Open. A "seen" mark
  // that quietly hides the issue would be the opposite of what it offers.
  expect
    .soft(
      await issueRows(page).count(),
      `marking an issue seen removed it from Open (${openBefore} issues before), but Mark seen promises it "stays in Open"`,
    )
    .toBe(openBefore);
  expect.soft(await tabCount(page, 'Snoozed'), 'marking an issue seen moved it into Snoozed').toBe(snoozedBefore);
  expect.soft(await tabCount(page, 'Dismissed'), 'marking an issue seen moved it into Dismissed').toBe(dismissedBefore);

  await captureSurface(page, testInfo, 'issues-marked-seen');

  const unmark = page.locator('button[aria-label*="click to unmark" i]').first();
  await expect(unmark, 'an issue can be marked seen but the mark cannot be removed').toBeVisible({ timeout: 20_000 });
  await unmark.click();

  await expect
    .poll(async () => (await triageRecords(page)).length, {
      message: `unmarking ${describeScope(record)} did not clear the record - the mark survives the undo`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(0);
});

test('snoozing an issue moves it to Snoozed, and it can be brought back to Open', async ({ page }, testInfo) => {
  const openBefore = await issueRows(page).count();
  const snoozedBefore = await tabCount(page, 'Snoozed');

  await issueRows(page).first().locator('button[aria-label^="Snooze" i]').first().click();

  // "until a time you pick" - so there has to be something to pick.
  const oneHour = page.getByRole('menuitem', { name: '1 hour' }).first();
  await expect(oneHour, 'the Snooze control offers no durations, though it promises "a time you pick"').toBeVisible({
    timeout: 20_000,
  });
  await captureSurface(page, testInfo, 'issue-snooze-durations');
  await oneHour.click();

  await expect
    .poll(async () => (await triageRecords(page)).map((r) => r.verb), {
      message: 'snoozing an issue stored nothing on the hub',
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toEqual(['snooze']);
  const [record] = await triageRecords(page);

  // A snooze that returns automatically must say when. Without an expiry the
  // issue is dismissed, not snoozed.
  expect
    .soft(
      (record as TriageRecord & { expiresAt?: string })?.expiresAt ?? '',
      `${describeScope(record)} was stored without an expiry, so it will never "return automatically"`,
    )
    .not.toBe('');

  await expect
    .poll(async () => tabCount(page, 'Snoozed'), {
      message: `snoozing ${describeScope(record)} did not increase the Snoozed count (was ${snoozedBefore})`,
      timeout: 30_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(snoozedBefore);

  // And it must actually leave Open, not merely be counted elsewhere.
  await expect
    .poll(async () => issueRows(page).count(), {
      message: `${describeScope(record)} was snoozed but the Open queue still lists ${openBefore} issues`,
      timeout: 25_000,
      intervals: [1000, 2000],
    })
    .toBe(openBefore - 1);

  await page.locator('button', { hasText: /^Snoozed/ }).first().click();
  const bringBack = page.locator('button[aria-label*="bring it back to Open" i]').first();
  await expect(
    bringBack,
    `${describeScope(record)} was snoozed and the Snoozed tab offers no way to bring it back before the timer expires`,
  ).toBeVisible({ timeout: 25_000 });
  await captureSurface(page, testInfo, 'issues-snoozed-tab');
  await bringBack.click();

  await expect
    .poll(async () => (await triageRecords(page)).length, {
      message: `bringing ${describeScope(record)} back to Open did not clear the snooze`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(0);
});

test('dismissing an issue moves it out of Open, and the dismissal can be undone', async ({ page }, testInfo) => {
  const openBefore = await issueRows(page).count();
  const dismissedBefore = await tabCount(page, 'Dismissed');
  expect.soft(dismissedBefore, 'could not read the Dismissed count from the Issues page').toBeGreaterThanOrEqual(0);

  await issueRows(page).first().locator('button[aria-label^="Dismiss" i]').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog, 'the Dismiss dialog never opened').toBeVisible({ timeout: 20_000 });

  // A confirmation that does not say what it is confirming is how the wrong
  // issue gets hidden from the whole org.
  const named = (await dialog.innerText()).match(/Dismiss\s+[“"']([^”"']+)[”"']/)?.[1] ?? '';
  expect.soft(named, 'the Dismiss dialog does not name the issue it is about to hide').not.toBe('');

  await captureSurface(page, testInfo, 'issue-dismiss-dialog', dialog);

  // Reason is required - the dialog marks it with an asterisk.
  // Located by element and text, not by role: the reason picker is a <button>
  // element but is not exposed with the button role, so getByRole('button')
  // never matched it and the test sat on that click until the timeout.
  const reasonTrigger = dialog.locator('button', { hasText: /Select a reason/i }).first();
  await expect(reasonTrigger, 'the Dismiss dialog has no reason picker, though Reason is marked required').toBeVisible({
    timeout: 20_000,
  });
  await reasonTrigger.click();

  // The picker may render as a listbox, a menu, or plain buttons - take
  // whichever appears rather than assuming one.
  const choice = page
    .getByRole('option')
    .or(page.getByRole('menuitem'))
    .or(page.locator('[role=listbox] button, [role=menu] button'))
    .first();
  const picked = await expect(choice)
    .toBeVisible({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  expect
    .soft(picked, 'the reason picker opened but offered nothing to select, so a required field cannot be filled')
    .toBe(true);
  if (picked) await choice.click();

  await dialog.getByRole('button', { name: /^Dismiss issue$/i }).click();

  await expect
    .poll(async () => (await triageRecords(page)).map((r) => r.verb), {
      message: `dismissing "${named}" stored nothing on the hub, though the dialog reported success`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toEqual(['dismiss']);
  const [record] = await triageRecords(page);

  await expect
    .poll(async () => tabCount(page, 'Dismissed'), {
      message:
        `dismissing ${describeScope(record)} did not increase the Dismissed count (was ${dismissedBefore}) - ` +
        `the action reports success but the issue has not moved out of the Open queue`,
      timeout: 30_000,
      intervals: [1000, 2000, 3000],
    })
    .toBeGreaterThan(dismissedBefore);

  await expect
    .poll(async () => issueRows(page).count(), {
      message: `${describeScope(record)} was dismissed but the Open queue still lists ${openBefore} issues`,
      timeout: 25_000,
      intervals: [1000, 2000],
    })
    .toBe(openBefore - 1);

  await captureSurface(page, testInfo, 'issues-after-dismiss');

  // The dialog promises "until you undo it", so undo is part of the feature.
  await page.locator('button', { hasText: /^Dismissed/ }).first().click();
  const undo = page.locator('button[aria-label*="click to undo" i]').first();
  await expect(
    undo,
    `${describeScope(record)} was dismissed and the Dismissed tab offers no way to undo it - the dialog ` +
      `promises "until you undo it", so a user who dismisses by mistake is stuck`,
  ).toBeVisible({ timeout: 25_000 });
  await undo.click();

  await expect
    .poll(async () => (await triageRecords(page)).length, {
      message: `undoing the dismissal of ${describeScope(record)} did not clear it`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(0);
  await expect
    .poll(async () => tabCount(page, 'Dismissed'), {
      message: `the dismissal was undone but the Dismissed count did not return to ${dismissedBefore}`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(dismissedBefore);
  await captureSurface(page, testInfo, 'issues-after-undo');
});
