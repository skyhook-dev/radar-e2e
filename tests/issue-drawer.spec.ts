import { test, expect, type Page, type Locator } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited } from './helpers';

// The issue detail drawer - where triage actually happens.
//
// The Issues list says what is wrong in one line. The drawer is where an
// operator decides what to do about it, and it is the densest explanatory
// surface in the product: WHAT'S WRONG, NEXT STEP, CONTEXT and SUBJECT. None
// of it was covered by any test.
//
// What is checked here, for several different kinds of issue:
//   - the drawer opens at all
//   - it is about the SAME resource the row was about
//   - it says what is wrong
//   - whether it says what to do next is RECORDED per issue and asserted only
//     in aggregate: most types carry a NEXT STEP, "Workload degraded" does not,
//     and nothing here establishes that every type is meant to
//   - and, most importantly, DIFFERENT issues produce DIFFERENT drawers
//
// That last one is not hypothetical. While writing this, three rows in a row
// appeared to show identical drawer content, which looked exactly like a
// template rendering the first issue for everything. It was not: the drawer
// does not close on Escape, so the second and third clicks never registered
// and the same panel was being read three times. The product was right and the
// probe was wrong - so the assertion is written the way that would have caught
// a real version of that bug, and the drawer is closed the way the product
// actually supports.
//
// Read off the running product before being written:
//   - Clicking a row opens the drawer; clicking the SAME row again closes it.
//     Escape does not close it, and neither does clicking outside it.
//   - The panel is not a dialog and has no close control with an accessible
//     name, so it cannot be located by role.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

const DRAWER_MARKER = "WHAT'S WRONG";

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);
const drawerOpen = (page: Page) => page.evaluate((m) => document.body.innerText.includes(m), DRAWER_MARKER);

const issueRows = (page: Page) =>
  page.locator('[role=button]').filter({ has: page.locator('button[aria-label^="Dismiss" i]') });

/** Everything the drawer says, from its first heading onwards. */
async function drawerText(page: Page): Promise<string> {
  return page.evaluate((m) => {
    const t = document.body.innerText;
    const i = t.indexOf(m);
    return i < 0 ? '' : t.slice(i);
  }, DRAWER_MARKER);
}

/** The namespace/name the row is about, e.g. "e2e-fixtures / broken-image". */
function subjectOf(rowText: string): string {
  const m = rowText.match(/([a-z0-9][a-z0-9.-]*)\s*\/\s*([a-z0-9][a-z0-9.-]*)/);
  return m ? m[2] : '';
}

async function openDrawer(page: Page, row: Locator) {
  await row.click();
  await expect
    .poll(() => drawerOpen(page), { timeout: 30_000, intervals: [500, 1000, 2000] })
    .toBe(true);
}

async function closeDrawer(page: Page, row: Locator) {
  // The same row toggles it shut. Escape does nothing here, and leaving it
  // open makes the next row's click land on a panel instead of the list.
  await row.click();
  await expect
    .poll(() => drawerOpen(page), { timeout: 30_000, intervals: [500, 1000, 2000] })
    .toBe(false);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('the issue drawer explains the issue it was opened from, and differs from other issues', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/issues');

  const rows = issueRows(page);
  await expect(rows.first(), 'the Issues queue is empty, so there is no drawer to open').toBeVisible({
    timeout: 60_000,
  });

  const total = await rows.count();
  const sample = Math.min(total, 4);
  expect.soft(total, 'the fixture cluster should raise several kinds of issue').toBeGreaterThan(1);

  const seen: { title: string; text: string }[] = [];
  const withoutNextStep: string[] = [];

  for (let i = 0; i < sample; i++) {
    const row = rows.nth(i);
    const rowText = (await row.innerText()).trim();
    const title = rowText.split('\n')[0];
    const subject = subjectOf(rowText);

    await openDrawer(page, row);
    const text = await drawerText(page);

    // It has to be about the resource the operator clicked on.
    if (subject) {
      expect
        .soft(
          text,
          `the drawer opened from "${title}" (${subject}) never names that resource - an operator acting on this ` +
            `panel would be acting on the wrong thing`,
        )
        .toContain(subject);
    }

    // Whether it says what to DO is recorded rather than demanded. Most issue
    // types carry a NEXT STEP - the image-pull and unschedulable drawers both
    // do - but "Workload degraded" does not, and nothing here establishes that
    // every issue type is meant to. Asserting it per issue would file a defect
    // this suite has not verified. What IS asserted, below the loop, is that
    // the product offers guidance at all; a build where every drawer lost its
    // next step is a regression worth catching.
    const hasNextStep = /NEXT STEP|HOW TO FIX|remediat|Verify |lower the|Check /i.test(text);
    if (!hasNextStep) withoutNextStep.push(title);
    testInfo.annotations.push({
      type: 'drawer',
      description: `${title}: ${hasNextStep ? 'offers a next step' : 'no next step'}`,
    });

    // Different issues must produce different explanations.
    for (const previous of seen) {
      if (previous.title === title) continue;
      expect
        .soft(
          text === previous.text,
          `the drawer for "${title}" is word-for-word identical to the one for "${previous.title}" - ` +
            `either the panel is not updating or every issue is being explained with the same template`,
        )
        .toBe(false);
    }

    seen.push({ title, text });
    if (i === 0) await captureSurface(page, testInfo, 'issue-drawer');
    await closeDrawer(page, row);
  }

  expect.soft(seen.length, 'no issue drawer could be opened at all').toBeGreaterThan(0);

  // The regression that would matter: guidance disappearing everywhere.
  expect
    .soft(
      withoutNextStep.length,
      `not one of the ${seen.length} drawers opened offers a next step (${withoutNextStep.join(', ')}) - ` +
        `the panel has become a restatement of the list`,
    )
    .toBeLessThan(seen.length);
});

test('the drawer closes again and leaves the queue usable', async ({ page }) => {
  await gotoWhenNotRateLimited(page, '/issues');

  const rows = issueRows(page);
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const before = await rows.count();

  const row = rows.first();
  await openDrawer(page, row);
  await closeDrawer(page, row);

  // The list has to survive the round trip - a drawer that leaves the queue
  // empty or filtered behind it is worse than one that will not open.
  await expect
    .poll(async () => issueRows(page).count(), {
      message: `the Issues queue listed ${before} issue(s) before the drawer was opened and a different number after closing it`,
      timeout: 30_000,
      intervals: [1000, 2000],
    })
    .toBe(before);

  expect
    .soft(await bodyText(page), 'the Issues page lost its heading after the drawer round trip')
    .toMatch(/Issues|triage/i);
});
