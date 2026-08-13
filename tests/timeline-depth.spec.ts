import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited } from './helpers';

// The Timeline's own controls.
//
// timeline.spec.ts proves the important thing - a change made with kubectl
// reaches the timeline - but the page is mostly controls, and none of them
// were exercised: a range picker, zoom, four event-type filters, a kind
// filter, a deleted toggle and two view modes.
//
// The filters advertise a number each ("Changes 124", "Problems 158"), and the
// page prints what it is showing ("Showing 15 resources · 207 events"). That
// makes the contract checkable exactly rather than approximately: selecting a
// filter must show the number of events that filter promised. A filter that
// changes the view by some arbitrary amount is indistinguishable from one that
// filters wrongly.
//
// Read off the running product before being written:
//   - All / Changes / K8s Events are <button role="radio"> - getByRole('button')
//     does not match them, which reads as the controls not existing.
//   - Problems is a separate toggle with aria-pressed.
//   - Selecting Problems took the page from 207 events to exactly 158, its own
//     badge number.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

/** "Showing 15 resources · 207 events" -> 207. */
async function shownEvents(page: Page): Promise<number | null> {
  const m = (await bodyText(page)).match(/Showing\s+\d+\s+resources?\s*·\s*(\d+)\s+events?/);
  return m ? Number(m[1]) : null;
}

/** The number a filter advertises on its own badge. */
async function badgeCount(page: Page, label: string): Promise<number | null> {
  const m = (await bodyText(page)).match(new RegExp(`${label}\\s*\\n\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}

async function openTimeline(page: Page) {
  await gotoWhenNotRateLimited(page, '/timeline');
  await expect
    .poll(async () => shownEvents(page), {
      message: 'the Timeline never said how many events it is showing, so its filters cannot be judged',
      timeout: 90_000,
      intervals: [2000, 3000, 5000],
    })
    .not.toBeNull();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('each Timeline event filter shows exactly the number of events it advertises', async ({ page }, testInfo) => {
  await openTimeline(page);

  const total = await shownEvents(page);
  expect(total, 'the Timeline is showing no events at all, so there is nothing to filter').toBeGreaterThan(0);

  // Radios, not buttons. All three are checked, each softly, so one broken
  // filter does not hide the state of the others.
  for (const label of ['Changes', 'K8s Events', 'All']) {
    const promised = await badgeCount(page, label);
    const control = page.getByRole('radio', { name: new RegExp(`^${label}\\b`) }).first();

    const there = await expect(control)
      .toBeVisible({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect.soft(there, `the Timeline offers no "${label}" filter`).toBe(true);
    if (!there || promised === null) continue;

    await control.click();
    const settled = await expect
      .poll(async () => shownEvents(page), { timeout: 45_000, intervals: [1000, 2000, 3000] })
      .toBe(promised)
      .then(() => true)
      .catch(() => false);

    expect
      .soft(
        settled,
        `the Timeline's "${label}" filter says it covers ${promised} event(s) but selecting it shows ` +
          `${await shownEvents(page)} - the count on the control and the view behind it disagree`,
      )
      .toBe(true);

    await captureSurface(page, testInfo, `timeline-filter-${label.toLowerCase().replace(/\s+/g, '-')}`);
  }
});

test('the Problems toggle narrows the Timeline to problems and releases it again', async ({ page }, testInfo) => {
  await openTimeline(page);

  const before = await shownEvents(page);
  const promised = await badgeCount(page, 'Problems');
  const toggle = page.getByRole('button', { name: /^Problems\b/ }).first();

  const there = await expect(toggle)
    .toBeVisible({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  expect.soft(there, 'the Timeline offers no Problems toggle').toBe(true);
  test.skip(!there || promised === null, 'no Problems filter to exercise');

  await toggle.click();
  await expect
    .poll(async () => shownEvents(page), {
      message: `the Problems filter promises ${promised} event(s) but the Timeline shows a different number`,
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(promised);
  expect
    .soft(await toggle.getAttribute('aria-pressed'), 'the Problems filter does not report itself as active')
    .toBe('true');

  await captureSurface(page, testInfo, 'timeline-problems-only');

  // And releasing it has to give the rest back - a filter you cannot clear
  // leaves the operator on a partial view without knowing it.
  await toggle.click();
  await expect
    .poll(async () => shownEvents(page), {
      message: `clearing the Problems filter did not restore the full ${before} event(s)`,
      timeout: 45_000,
      intervals: [1000, 2000, 3000],
    })
    .toBe(before);
});

test('the Timeline can be read as a list or as a timeline', async ({ page }, testInfo) => {
  await openTimeline(page);

  const views = ['List', 'Timeline'];
  const rendered: Record<string, string> = {};

  for (const view of views) {
    const control = page.getByRole('button', { name: new RegExp(`^${view}$`) }).first();
    const there = await expect(control)
      .toBeVisible({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect.soft(there, `the Timeline offers no "${view}" view`).toBe(true);
    if (!there) continue;

    await control.click();
    await page.waitForTimeout(2500);
    rendered[view] = await bodyText(page);

    expect
      .soft(rendered[view].length, `the Timeline "${view}" view rendered almost nothing`)
      .toBeGreaterThan(400);
    await captureSurface(page, testInfo, `timeline-view-${view.toLowerCase()}`);
  }

  // The two views have to actually differ - a toggle that relabels itself and
  // renders the same thing is a control that does nothing.
  if (rendered.List && rendered.Timeline) {
    expect
      .soft(
        rendered.List === rendered.Timeline,
        'the Timeline "List" and "Timeline" views render identical content, so one of them does nothing',
      )
      .toBe(false);
  }
});
