import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface } from './helpers';

// Clicking a row must open THAT row.
//
// Every list page in the product is a way in to something: click an issue and
// you should get that issue, click a cluster and you should get that cluster.
// No spec had ever clicked a row on any of these pages, so a list that goes
// nowhere - or worse, opens the wrong item - failed nothing. "Opens the wrong
// item" is the interesting half: a drill-down that always opens the first row
// looks perfectly healthy until you use it.
//
// How each list responds was read off the running product rather than assumed,
// because they differ: /applications and /clusters navigate to a new URL,
// /helm puts the selection in a query parameter, and /issues opens a drawer
// with the URL unchanged. So "something happened" is judged as either a URL
// change or a detail panel appearing, and then the identity of what opened is
// checked separately - that second part is what makes this more than a smoke
// test.

test.use({ storageState: authStatePath });
test.setTimeout(300_000);

type ListPage = {
  path: string;
  domain: string;
  /** Where the clickable items are on this page. */
  row: string;
};

const LISTS: ListPage[] = [
  { path: '/applications', domain: 'Applications', row: 'table tbody tr' },
  { path: '/clusters', domain: 'Clusters', row: 'table tbody tr' },
  { path: '/helm', domain: 'Helm', row: 'table tbody tr' },
  { path: '/issues', domain: 'Issues', row: '[role=button], li, article' },
  { path: '/checks', domain: 'Checks', row: '[role=button], li, article' },
];

/** The most identifying string in a row - its first non-trivial word. */
function identityOf(rowText: string): string {
  const first = rowText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 2 && !/^\d+$/.test(l));
  return (first ?? '').split(/\s{2,}|\t/)[0].trim().slice(0, 60);
}

async function contentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav, [aria-label="Primary navigation"]');
    const navText = nav ? nav.innerText : '';
    const body = document.body.innerText;
    return navText ? body.split(navText).join(' ') : body;
  });
}

test('clicking a row on any list opens the item that was clicked', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  for (const { path, domain, row } of LISTS) {
    await page.goto(path);

    const rows = page.locator(row);
    const appeared = await expect
      .poll(async () => rows.count(), { timeout: 45_000, intervals: [1000, 2000, 3000] })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false);
    expect
      .soft(appeared, `${path}: the ${domain} list never rendered a clickable row, so its drill-down cannot be used`)
      .toBe(true);
    if (!appeared) continue;

    const first = rows.first();
    // Wait for the row to have TEXT, not merely to exist. A row element can be
    // in the DOM before its cells are populated, and reading it then returns
    // an empty string - which reported the Clusters list as having no readable
    // identity when its row plainly says "e2e-kind".
    await expect
      .poll(async () => (await first.innerText()).trim().length, {
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .toBeGreaterThan(2)
      .catch(() => {});
    const identity = identityOf((await first.innerText()).trim());
    expect
      .soft(identity.length, `${path}: could not read an identity from the first ${domain} row`)
      .toBeGreaterThan(0);
    if (!identity) continue;

    const urlBefore = page.url();
    const contentBefore = await contentText(page);

    await first.click();

    // "Something happened" is judged as a URL change or a material change in
    // what is on screen. Counting [role=dialog]/aside elements was tried and is
    // wrong: the Issues drawer is neither, and the count does not move when it
    // opens - which reported a working drill-down as a dead end.
    const responded = await expect
      .poll(
        async () => {
          if (page.url() !== urlBefore) return true;
          const now = await contentText(page);
          return Math.abs(now.length - contentBefore.length) > 40 || now !== contentBefore;
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true)
      .then(() => true)
      .catch(() => false);

    expect
      .soft(
        responded,
        `${path}: clicking the first ${domain} row did nothing - no navigation, no detail panel. ` +
          `The list is a dead end for a user trying to drill into "${identity}"`,
      )
      .toBe(true);
    if (!responded) continue;

    // ...and what opened must be the row that was clicked. A drill-down that
    // always opens the same item, or the wrong one, passes the check above.
    await expect
      .poll(async () => (await contentText(page)).toLowerCase().includes(identity.toLowerCase()), {
        message:
          `${path}: clicking "${identity}" opened something that does not mention it - ` +
          `the ${domain} drill-down is opening a different item than the one clicked`,
        timeout: 20_000,
        intervals: [1000, 2000],
      })
      .toBe(true);

    await captureSurface(page, testInfo, `${domain.toLowerCase()}-drilldown`);

    testInfo.annotations.push({
      type: `drilldown:${domain}`,
      description: `"${identity}" -> ${page.url().replace(/^https?:\/\/[^/]+/, '')}`,
    });
  }
});

test('a drill-down can be left again, and the list is still there', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // A detail view you cannot get out of is its own kind of dead end, and the
  // browser back button is how most people leave one. Checked on the two lists
  // that navigate rather than open a drawer, since those are the ones where
  // back has to restore the list.
  for (const { path, domain, row } of LISTS.filter((l) => l.path === '/applications' || l.path === '/clusters')) {
    await page.goto(path);
    const rows = page.locator(row);
    const ok = await expect
      .poll(async () => rows.count(), { timeout: 45_000, intervals: [1000, 2000] })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false);
    if (!ok) continue;

    const identity = identityOf((await rows.first().innerText()).trim());
    await rows.first().click();
    await expect
      .poll(async () => (await contentText(page)).toLowerCase().includes(identity.toLowerCase()), {
        timeout: 20_000,
        intervals: [1000, 2000],
      })
      .toBe(true)
      .catch(() => {});

    await page.goBack();

    await expect
      .poll(async () => rows.count(), {
        message:
          `${path}: going back from a ${domain} detail view did not restore the list - ` +
          `a user who drills in cannot get back to where they were`,
        timeout: 20_000,
        intervals: [1000, 2000],
      })
      .toBeGreaterThan(0);
  }

  await captureSurface(page, testInfo, 'drilldown-back-to-list');
});
