import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface } from './helpers';

// The controls each domain page offers, actually exercised.
//
// Everything up to here proved a domain RENDERS in each of its locations. That
// is presence, not depth: every one of these pages has a search box, most have
// filters or state tabs, and none of it was ever driven. A search that returns
// the same rows whatever you type, or a filter tab that changes nothing, looks
// completely healthy in a screenshot and is exactly the sort of thing a user
// hits in the first minute.
//
// The controls below were read off the running product rather than guessed:
// each `search` string is the real placeholder on that page.
//
// Every domain is checked for the same three properties, all soft so one
// broken page reports alongside the others rather than instead of them:
//
//   1. searching for something that IS there keeps it on screen
//   2. searching for something that is NOT there empties the view, and says so
//      rather than silently showing everything or crashing
//   3. clearing the box brings the original set back
//
// (2) is the one that catches a dead search box: a control that ignores input
// passes (1) and (3) trivially.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

const NONSENSE = 'zzqx-not-a-real-resource-9713';

/** Domain pages with a search/filter control, and a term the fixture guarantees. */
const SEARCHABLE: { path: string; domain: string; search: string; term: string }[] = [
  // Verified against the running page, not assumed. /resources carries THREE
  // inputs: "Filter resources..." narrows the KIND list in the left column and
  // leaves the table at 20 rows, while "Search... (press /)" is the one that
  // filters the table (20 rows -> 0 on a term matching nothing). Using the
  // first produced a convincing "the search box does not filter" failure
  // against a control that was working exactly as designed.
  //
  // The page also defaults to PODS, so a Deployment name would never have been
  // on it to filter.
  { path: '/resources', domain: 'Resources', search: 'Search... (press /)', term: 'chatty' },
  { path: '/helm', domain: 'Helm', search: 'Search releases...', term: 'radar-hub' },
  { path: '/clusters', domain: 'Clusters', search: 'Filter by name, id, or tag', term: 'e2e-kind' },
  { path: '/packages', domain: 'Packages', search: 'Filter packages by name', term: 'radar' },
  // 'chatty' rather than 'storefront': the table appears to render only the
  // rows in view, so a name further down the list is absent from the DOM and
  // reads as missing. A term near the top tests the filter without depending
  // on how much of the list happens to be materialised.
  { path: '/applications', domain: 'Applications', search: 'Search...', term: 'chatty' },
  { path: '/issues', domain: 'Issues', search: 'Search issues', term: 'broken-image' },
  { path: '/checks', domain: 'Checks', search: 'Search checks', term: 'privilege' },
];

/**
 * Whether a known item is on screen.
 *
 * Counting rows was tried first and does not generalise: /issues and /checks
 * render no table rows at all, and falling back to page-text length is worse
 * than useless because an empty-state message makes a filtered page LONGER
 * than an unfiltered one. Asking whether a specific item the fixture
 * guarantees is present sidesteps both problems and is a sharper question
 * anyway - a filter is broken precisely when it fails to remove things.
 */
async function shows(page: Page, term: string): Promise<boolean> {
  // Content only, with the navigation stripped out. The nav carries the
  // product name, so searching /helm for a release called "radar" matched the
  // "Radar" brand in the sidebar on every single render - the filter looked
  // permanently broken when nothing was wrong with it.
  const text = await page.evaluate(() => {
    const nav = document.querySelector('nav, [aria-label="Primary navigation"]');
    const navText = nav ? nav.innerText : '';
    const body = document.body.innerText;
    return navText ? body.split(navText).join(' ') : body;
  });
  return text.toLowerCase().includes(term.toLowerCase());
}

async function searchBox(page: Page, placeholder: string) {
  return page.getByPlaceholder(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
}

test('every domain search box actually filters what it shows', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  for (const { path, domain, search, term } of SEARCHABLE) {
    await page.goto(path);

    const box = await searchBox(page, search);
    // toBeVisible, not isVisible: the latter answers "right now" and the page
    // is still rendering. That mistake reported five of these controls as
    // missing when every one of them exists.
    const present = await expect(box)
      .toBeVisible({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    expect
      .soft(present, `${path}: the ${domain} page never rendered its "${search}" control`)
      .toBe(true);
    if (!present) continue;

    // The item must be there before filtering, or nothing below means anything.
    const baseline = await expect
      .poll(() => shows(page, term), { timeout: 30_000, intervals: [1000, 2000] })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    expect
      .soft(
        baseline,
        `${path}: "${term}" is not on the ${domain} page before filtering, although it exists in this cluster - ` +
          `the page is not showing what it should, so its filter cannot be judged`,
      )
      .toBe(true);
    if (!baseline) continue;

    // 1. Nonsense must REMOVE it. This is the check that catches a search box
    //    which accepts input and ignores it - such a box passes every other
    //    assertion here trivially.
    await box.fill(NONSENSE);
    await expect
      .poll(() => shows(page, term), {
        message:
          `${path}: searching the ${domain} page for "${NONSENSE}" still shows "${term}" - ` +
          `the search box takes input and does not filter on it`,
        timeout: 25_000,
        intervals: [1000, 2000],
      })
      .toBe(false);

    // ...and it must say so, rather than leaving a blank panel that reads as
    // still-loading.
    const emptyText = (await page.locator('body').innerText()).toLowerCase();
    expect
      .soft(
        /no |none|nothing|empty|not found|no results|no matches/i.test(emptyText),
        `${path}: a search matching nothing left the ${domain} page with no empty-state message - ` +
          `a user cannot tell "nothing matches" from "still loading"`,
      )
      .toBe(true);

    await captureSurface(page, testInfo, `${domain.toLowerCase()}-search-no-matches`);

    // 2. Searching for the item itself must bring it back.
    await box.fill(term);
    await expect
      .poll(() => shows(page, term), {
        message: `${path}: searching the ${domain} page for "${term}" hid it, although it exists in this cluster`,
        timeout: 25_000,
        intervals: [1000, 2000],
      })
      .toBe(true);

    await captureSurface(page, testInfo, `${domain.toLowerCase()}-search-match`);

    // 3. Clearing must restore the unfiltered view - a filter you cannot undo
    //    strands the user on a subset.
    await box.fill('');
    await expect
      .poll(() => shows(page, term), {
        message: `${path}: clearing the ${domain} search did not bring "${term}" back`,
        timeout: 25_000,
        intervals: [1000, 2000],
      })
      .toBe(true);
  }
});

/** State tabs that partition a domain's items, read off the running product. */
const STATE_TABS: { path: string; domain: string; tabs: string[] }[] = [
  { path: '/issues', domain: 'Issues', tabs: ['Open', 'Snoozed', 'Dismissed', 'All'] },
  { path: '/checks', domain: 'Checks', tabs: ['Open', 'Snoozed', 'Dismissed', 'All'] },
  { path: '/alerts', domain: 'Alerts', tabs: ['All', 'Open', 'Resolved'] },
];

test('the state filters on a domain page change what it shows', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  for (const { path, domain, tabs } of STATE_TABS) {
    await page.goto(path);
    await expect
      .poll(async () => (await page.locator('body').innerText()).trim().length, {
        message: `${path}: never rendered`,
        timeout: 45_000,
        intervals: [1000, 2000, 3000],
      })
      .toBeGreaterThan(200);

    const seen = new Map<string, string>();
    let previous = '';
    for (const tab of tabs) {
      const control = page.getByRole('button', { name: new RegExp(`^\\s*${tab}\\b`, 'i') }).first();
      // Waited, not sampled - see the note on the search control above.
      const there = await expect(control)
        .toBeVisible({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      expect
        .soft(there, `${path}: the ${domain} page offers no "${tab}" filter, though the product renders one`)
        .toBe(true);
      if (!there) continue;

      await control.click();

      // Wait for the list to actually change rather than reading straight
      // after the click. Polling only for "the page has some text" is
      // satisfied by the chrome before the list re-renders, which made two
      // filters look byte-identical when the second had simply not painted
      // yet. If it genuinely never changes, this times out and the comparison
      // below reports it - that distinction is the whole point.
      if (previous) {
        await expect
          .poll(async () => (await page.locator('body').innerText()).trim() !== previous, {
            timeout: 15_000,
            intervals: [500, 1000, 2000],
          })
          .toBe(true)
          .catch(() => {});
      }

      const text = (await page.locator('body').innerText()).trim();
      await expect
        .soft(
          page.getByText(/something went wrong|failed to load/i).first(),
          `${path}: the ${domain} "${tab}" filter rendered an error`,
        )
        .toBeHidden({ timeout: 8_000 });

      seen.set(tab, text);
      previous = text;
      await captureSurface(page, testInfo, `${domain.toLowerCase()}-filter-${tab.toLowerCase()}`);
    }

    // Open and Dismissed cannot legitimately show the same thing when the
    // fixture guarantees open items and nothing has been dismissed. Identical
    // output after waiting for a change means the control is decorative.
    const open = seen.get('Open');
    const dismissed = seen.get('Dismissed');
    if (open && dismissed) {
      expect
        .soft(
          open !== dismissed,
          `${path}: the ${domain} "Open" and "Dismissed" filters render byte-identical content, after waiting for ` +
            `the list to change - with open items present and nothing dismissed, at least one of these does nothing`,
        )
        .toBe(true);
    }
  }
});
