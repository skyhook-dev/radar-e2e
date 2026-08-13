import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  dashboardCardText,
  gotoWhenNotRateLimited,
  waitForFleetReporting,
} from './helpers';

// The dashboard must agree with the pages it links to.
//
// Every domain in this product appears in at least two places: its own page,
// and a summary card on the home dashboard. Those are two different code paths
// over two different queries, and nothing until now compared them. A card that
// says "5 issues" while its page lists 3 is worse than either number being
// wrong on its own - the operator cannot tell which one to believe, and the
// dashboard is the surface they look at first.
//
// So each card is read, then its own link is followed, and the two are held to
// each other. No fixture numbers are hardcoded: the cluster's real state is
// whatever it is, and the assertion is that the product tells the same story
// about it twice.
//
// Read off the running product before being written:
//  - The Issues card links to /issues?cluster=<id> with the open count as its
//    text, and breaks it down as "<n> critical" / "<n> warning".
//  - The Checks card links to /checks?clusters=<id> with a total finding count,
//    and both surfaces print the same "452 of 633 passing" phrase.
//  - On /checks that same total is split into "N actionable" and
//    "M platform-managed", which sum to the card's number.
//  - Issue rows carry per-row action buttons; counting rows by the Dismiss
//    button is the anchor that survives every row state.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

/**
 * How many critical issues a surface claims.
 *
 * Scoped to the region that is actually about issue severity, never the whole
 * page: a loose search for "<n> critical" over document.innerText picks up
 * whatever number happens to sit near the word - on the Issues page it matched
 * a checks-severity count of 49 and reported a mismatch against a dashboard
 * that was telling the truth.
 */
async function criticalCount(page: Page, scope: 'dashboard' | 'issues'): Promise<number | null> {
  return page.evaluate((where) => {
    const blocks = [...document.querySelectorAll('div,section,aside')] as HTMLElement[];
    const region = where === 'dashboard'
      // The innermost matching block: the outermost is the whole page, whose
      // text contains every other number on it.
      ? blocks.filter((e) => /ACTIVE ISSUES/i.test(e.innerText)).pop()
      : blocks.filter((e) => /SEVERITY/i.test(e.innerText) && /Critical/i.test(e.innerText)).pop();
    if (!region) return null;
    // The two surfaces order the number and the word differently, and the
    // wrong pattern silently reads the NEXT count along:
    //   dashboard    "ACTIVE ISSUES | 5 | critical | 2 | warning"
    //   issues facet "SEVERITY | Critical | 5 | Warning | 2"
    // Matching /Critical\s*\n\s*(\d+)/ against the dashboard returns 2 - the
    // warning count - and reports a mismatch between two surfaces that agree.
    const m = where === 'dashboard'
      ? region.innerText.match(/(\d+)\s*\n\s*critical/i)
      : region.innerText.match(/Critical\s*\n\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  }, scope);
}

const issueRows = (page: Page) =>
  page.locator('[role=button]').filter({ has: page.locator('button[aria-label^="Dismiss" i]') });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
  // Connected is not the same as answering: the hub can hold an attached agent
  // that serves nothing, and every fleet-wide number then reads as zero.
  await waitForFleetReporting(page);
});

test('the Issues card on the dashboard agrees with the Issues page it links to', { tag: '@sanity' }, async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/');

  const card = page.locator('a[href^="/issues"]').filter({ hasText: /^\s*\d+\s*$/ }).first();
  const present = await expect(card)
    .toBeVisible({ timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  expect.soft(present, 'the dashboard has no Issues card showing a count').toBe(true);
  test.skip(!present, 'no Issues count card to compare');

  const claimed = Number((await card.innerText()).trim());
  expect.soft(Number.isInteger(claimed), 'the dashboard Issues card does not show a number').toBe(true);

  await captureSurface(page, testInfo, 'dashboard-issues-card');
  const href = (await card.getAttribute('href')) as string;

  // Compared with a retry, because the two surfaces are read seconds apart and
  // a live cluster does not hold still between them - a node going unready
  // adds an issue, and the dashboard read before it and the page read after it
  // legitimately differ. A disagreement only counts if it SURVIVES re-reading
  // the dashboard: same fact, both surfaces, still different.
  let dashboardCount = claimed;
  let dashboardCritical = await criticalCount(page, 'dashboard');
  let pageCount = -1;
  let pageCritical: number | null = null;
  let agreed = false;

  for (let attempt = 0; attempt < 3 && !agreed; attempt++) {
    // Follow the card's OWN link rather than navigating by hand - a card that
    // points somewhere unhelpful is itself the defect.
    await gotoWhenNotRateLimited(page, href);
    await expect
      .poll(async () => issueRows(page).count(), { timeout: 60_000, intervals: [2000, 3000, 5000] })
      .toBeGreaterThanOrEqual(0);
    pageCount = await issueRows(page).count();
    pageCritical = await criticalCount(page, 'issues');
    if (pageCount === dashboardCount) { agreed = true; break; }

    // Re-read the source: did the dashboard move too?
    await gotoWhenNotRateLimited(page, '/');
    const recard = page.locator('a[href^="/issues"]').filter({ hasText: /^\s*\d+\s*$/ }).first();
    await expect(recard).toBeVisible({ timeout: 45_000 });
    dashboardCount = Number((await recard.innerText()).trim());
    dashboardCritical = await criticalCount(page, 'dashboard');
  }

  expect(
    pageCount,
    `the dashboard says ${dashboardCount} open issue(s) and ${href} lists ${pageCount}, and they still ` +
      `disagree after re-reading both - one of the two surfaces is wrong about the same cluster`,
  ).toBe(dashboardCount);

  // The severity split must match too - a card can get the total right while
  // misattributing how bad it is.
  if (dashboardCritical !== null && pageCritical !== null) {
    expect
      .soft(
        pageCritical,
        `the dashboard reports ${dashboardCritical} critical issue(s) but the Issues page reports ${pageCritical}`,
      )
      .toBe(dashboardCritical);
  }

  await captureSurface(page, testInfo, 'dashboard-issues-page-agrees');
});

test('the Checks card on the dashboard agrees with the Checks page it links to', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/');

  // The Checks card fills in after the rest of the dashboard, so this waits for
  // it rather than reading the page the moment it renders.
  //
  // It can also settle on "Checks - unavailable", which happened on one variant
  // while the other showed the ratio. That is not automatically a defect: the
  // card is being honest about data it does not have. What WOULD be a defect is
  // the card claiming unavailable while the page behind it works, so that case
  // is carried through and checked against the page rather than failed here.
  //
  // Reloaded between attempts on purpose. "unavailable" is also what the card
  // shows when its own request was rate limited - the page itself says nothing
  // about a 429 in that case, so there is no other way to tell a card that
  // cannot fetch from a card that has nothing to fetch. Given a fresh load and
  // a recovered budget it fills in; without the reloads this reported a
  // dashboard that works as broken.
  const cardSettled = await expect
    .poll(
      async () => {
        const text = await dashboardCardText(page, '/checks');
        if (/\d+\s+of\s+\d+\s+passing/.test(text)) return true;
        await gotoWhenNotRateLimited(page, '/');
        return /\d+\s+of\s+\d+\s+passing/.test(await dashboardCardText(page, '/checks'));
      },
      { timeout: 180_000, intervals: [5000, 10_000, 15_000] },
    )
    .toBe(true)
    .then(() => true)
    .catch(() => false);

  const cardText = await dashboardCardText(page, '/checks');
  const dashboard = await bodyText(page);
  const passing = dashboard.match(/(\d+)\s+of\s+(\d+)\s+passing/);

  const card = page.locator('a[href^="/checks"]').filter({ hasText: /^\s*\d+\s*$/ }).first();
  const claimed = (await card.count()) ? Number((await card.innerText()).trim()) : null;

  await captureSurface(page, testInfo, 'dashboard-checks-card');
  await gotoWhenNotRateLimited(page, '/checks');

  await expect
    .poll(async () => (await bodyText(page)).length, { timeout: 60_000, intervals: [2000, 3000] })
    .toBeGreaterThan(300);
  const checksPage = await bodyText(page);

  // If the card said it had nothing, the page must agree. A card reporting
  // "unavailable" over a page that happily lists 181 findings is the dashboard
  // telling an operator their checks are not being collected when they are.
  if (!cardSettled && /unavailable/i.test(cardText)) {
    const pageHasData = /\d+\s+of\s+\d+\s+passing|\d+\s+actionable/.test(checksPage);
    expect
      .soft(
        pageHasData,
        `the dashboard Checks card says "unavailable" while the Checks page it links to is serving data - ` +
          `the dashboard is under-reporting what the product knows`,
      )
      .toBe(false);
  }

  // The same sentence, on both surfaces - one derived fact, printed twice by
  // two different queries.
  //
  // Compared with a re-read, because the ratio moves on its own: checks are
  // re-evaluated as the cluster changes, and 452 of 633 became 453 of 634
  // between two page loads during development. A disagreement only counts if
  // it survives going back to the dashboard and asking again.
  if (passing) {
    let agreed = checksPage.includes(passing[0]);
    let latest = passing[0];
    for (let attempt = 0; attempt < 2 && !agreed; attempt++) {
      await gotoWhenNotRateLimited(page, '/');
      const again = (await bodyText(page)).match(/(\d+)\s+of\s+(\d+)\s+passing/);
      if (!again) break;
      latest = again[0];
      await gotoWhenNotRateLimited(page, '/checks');
      await expect
        .poll(async () => (await bodyText(page)).length, { timeout: 60_000, intervals: [2000, 3000] })
        .toBeGreaterThan(300);
      agreed = (await bodyText(page)).includes(latest);
    }
    expect
      .soft(
        agreed,
        `the dashboard says "${latest}" but the Checks page it links to reports a different passing ratio, ` +
          `and they still disagree after re-reading both`,
      )
      .toBe(true);
  }

  // The card's total must account for everything the page splits it into.
  if (claimed !== null) {
    const actionable = Number(checksPage.match(/(\d+)\s+actionable/)?.[1] ?? NaN);
    const managed = Number(checksPage.match(/(\d+)\s+platform-managed/)?.[1] ?? NaN);
    if (Number.isInteger(actionable) && Number.isInteger(managed)) {
      expect
        .soft(
          actionable + managed,
          `the dashboard Checks card claims ${claimed} findings, but the Checks page accounts for ` +
            `${actionable} actionable + ${managed} platform-managed = ${actionable + managed}`,
        )
        .toBe(claimed);
    }
  }

  await captureSurface(page, testInfo, 'dashboard-checks-page-agrees');
});

test('every dashboard card links somewhere that loads and is about the same domain', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/');

  const cards = await page.evaluate(() => {
    const inNav = (e: Element) => !!e.closest('nav,[aria-label="Primary navigation"]');
    const seen = new Set<string>();
    return [...document.querySelectorAll('a[href^="/"]')]
      .filter((e) => !inNav(e))
      .map((e) => ({ href: (e.getAttribute('href') ?? '').split('?')[0], text: (e as HTMLElement).innerText.trim() }))
      .filter((c) => c.href && c.href !== '/' && !seen.has(c.href) && seen.add(c.href));
  });
  expect.soft(cards.length, 'the dashboard links nowhere at all').toBeGreaterThan(3);

  for (const { href } of cards) {
    await gotoWhenNotRateLimited(page, href);

    // Polled, not read once. Navigation returns as soon as the page is not
    // rate limited, which can be before it has rendered anything - and a
    // destination measured mid-render reports as an empty page.
    const rendered = await expect
      .poll(async () => (await bodyText(page)).length, { timeout: 45_000, intervals: [1000, 2000, 3000] })
      .toBeGreaterThan(200)
      .then(() => true)
      .catch(() => false);
    const text = await bodyText(page);

    expect
      .soft(rendered, `the dashboard links to ${href}, which renders almost nothing (${text.length} characters)`)
      .toBe(true);

    // The destination has to be the domain the card was about. Checked from
    // the URL the app settled on, so a card that silently redirects home -
    // the classic broken-link-that-looks-fine - is caught.
    expect
      .soft(
        new URL(page.url()).pathname,
        `the dashboard card for ${href} does not land there - a user clicking it ends up somewhere else`,
      )
      .toContain(href.split('/')[1]);

    await expect
      .soft(
        page.getByText(/something went wrong|unexpected error/i).first(),
        `the dashboard links to ${href}, which renders an error`,
      )
      .toBeHidden({ timeout: 10_000 });
  }

  await captureSurface(page, testInfo, 'dashboard-links-verified');
});
