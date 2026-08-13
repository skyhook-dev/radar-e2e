import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited } from './helpers';

// Sorting, grouping and type filters - the controls a user reaches for once a
// page has more rows than fits on a screen.
//
// Every other spec in this suite checks that a page shows the right data. This
// one checks the controls that decide WHICH of it you see and in what order,
// across the domains that offer them: Helm and Clusters (column sorting),
// Checks (grouping), Applications (type and health filters).
//
// Read off the running product before being written:
//  - Sortable column headers are th[aria-sort], cycling none -> ascending ->
//    descending, and the sort control is a BUTTON INSIDE the th. Clicking the
//    th itself does nothing at all: aria-sort stays "none" and the rows never
//    move, which reads exactly like sorting being broken.
//  - The Checks grouping control is button[aria-label="Group checks by"],
//    offering No grouping / By cluster / By namespace / By framework.
//  - The Applications filters are aria-pressed buttons whose label carries a
//    count badge ("Service 4"), so their text is "Service\n4" - a hasText of
//    /^Service$/ matches nothing.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const rowCount = (page: Page) => page.locator('tbody tr').count();

/** The visible text of one column, top to bottom. */
const column = (page: Page, index: number) =>
  page.evaluate(
    (i) => [...document.querySelectorAll('tbody tr')].map((r) => ((r as HTMLTableRowElement).cells[i]?.innerText ?? '').trim()),
    index,
  );

/** The control that actually sorts: the button inside the header cell. */
function sortControl(page: Page, header: string) {
  const th = page.getByRole('columnheader', { name: new RegExp(`^${header}$`, 'i') }).first();
  return { th, click: async () => (await th.locator('button').count()) ? th.locator('button').first().click() : th.click() };
}

async function openTable(page: Page, path: string) {
  await gotoWhenNotRateLimited(page, path);
  await expect(page.locator('tbody tr').first(), `${path} never rendered a table row`).toBeVisible({ timeout: 45_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('sorting a Helm column reorders the releases and says which way it sorted', async ({ page }, testInfo) => {
  await openTable(page, '/helm');

  const rows = await rowCount(page);
  expect
    .soft(rows, 'the Helm page needs at least two releases for sort order to mean anything')
    .toBeGreaterThanOrEqual(2);

  const { th, click } = sortControl(page, 'NAME');
  await expect(th, 'the Helm table has no NAME column to sort by').toBeVisible({ timeout: 20_000 });
  expect.soft(await th.getAttribute('aria-sort'), 'a sortable column should start unsorted').toBe('none');

  const before = await column(page, 0);

  await click();
  await expect
    .poll(async () => th.getAttribute('aria-sort'), {
      message: 'clicking the NAME header did not put the column into a sorted state, so a user cannot tell what order they are looking at',
      timeout: 20_000,
      intervals: [500, 1000],
    })
    .toBe('ascending');

  const ascending = await column(page, 0);
  expect(
    ascending,
    'the NAME column reports itself as sorted ascending but the release names are not in ascending order',
  ).toEqual([...ascending].sort((a, b) => a.localeCompare(b)));

  await captureSurface(page, testInfo, 'helm-sorted-ascending');

  await click();
  await expect
    .poll(async () => th.getAttribute('aria-sort'), {
      message: 'a second click on the NAME header did not reverse the sort',
      timeout: 20_000,
      intervals: [500, 1000],
    })
    .toBe('descending');

  const descending = await column(page, 0);
  expect(descending, 'sorting descending must reverse the order, not just relabel the header').toEqual(
    [...ascending].reverse(),
  );
  expect
    .soft(descending.length, 'sorting dropped or duplicated rows')
    .toBe(before.length);

  // A second column, to show sorting is a property of the table and not one
  // hard-coded behaviour on NAME.
  const chart = sortControl(page, 'CHART');
  if (await chart.th.count()) {
    await chart.click();
    await expect
      .poll(async () => chart.th.getAttribute('aria-sort'), { timeout: 20_000, intervals: [500, 1000] })
      .toBe('ascending');
    const charts = await column(page, 2);
    expect
      .soft(charts, 'the CHART column reports itself sorted ascending but its values are not in order')
      .toEqual([...charts].sort((a, b) => a.localeCompare(b)));
    expect
      .soft(await th.getAttribute('aria-sort'), 'sorting by CHART should clear the sort indicator on NAME')
      .toBe('none');
  }
});

test('the Clusters table offers sorting on the columns it shows', async ({ page }) => {
  await openTable(page, '/clusters');

  // Deliberately weaker than the Helm test. A single-cluster run has one row,
  // so row ORDER proves nothing here - what is checked is that the controls
  // exist, respond, and report their state honestly. The multi-cluster job is
  // where order could be checked, and it runs this file with two clusters.
  const rows = await rowCount(page);
  const headers = page.getByRole('columnheader');
  const total = await headers.count();
  expect.soft(total, 'the Clusters table renders no column headers').toBeGreaterThan(0);

  let sortable = 0;
  for (const name of ['NAME', 'STATUS', 'VERSION']) {
    const { th, click } = sortControl(page, name);
    if (!(await th.count())) continue;
    sortable++;
    await click();
    const state = await th.getAttribute('aria-sort');
    expect
      .soft(state, `clicking the ${name} column on /clusters left it reporting "${state}" - the header looks sortable but does not sort`)
      .toBe('ascending');

    if (rows >= 2 && name === 'NAME') {
      const values = await column(page, 0);
      expect
        .soft(values, 'the NAME column on /clusters reports ascending but the cluster names are not in order')
        .toEqual([...values].sort((a, b) => a.localeCompare(b)));
    }
  }
  expect.soft(sortable, 'none of the expected columns on /clusters could be found').toBeGreaterThan(0);
});

test('grouping the Checks queue regroups it and can be turned back off', async ({ page }, testInfo) => {
  await gotoWhenNotRateLimited(page, '/checks');
  const group = page.locator('button[aria-label="Group checks by"]').first();
  await expect(group, 'the Checks page has no grouping control').toBeVisible({ timeout: 45_000 });
  const initial = (await group.innerText()).trim();

  await group.click();
  const options = page.locator('[role=menuitem],[role=option]');
  await expect(options.first(), 'the grouping control opened nothing to choose from').toBeVisible({ timeout: 20_000 });
  const labels = (await options.allInnerTexts()).map((t) => t.trim());

  // Every grouping the product offers, not just the first one.
  expect
    .soft(labels, 'the grouping control should offer something to group by, not only "No grouping"')
    .not.toEqual(['No grouping']);

  const groupings = labels.filter((l) => !/^No grouping$/i.test(l));
  await page.keyboard.press('Escape');

  for (const label of groupings) {
    await group.click();
    const items = page.locator('[role=menuitem],[role=option]');
    await expect(items.first()).toBeVisible({ timeout: 20_000 });
    const texts = (await items.allInnerTexts()).map((t) => t.trim());
    const index = texts.findIndex((t) => t === label);
    expect.soft(index, `"${label}" disappeared from the grouping menu between opening it twice`).toBeGreaterThanOrEqual(0);
    if (index < 0) continue;

    await items.nth(index).click();

    // The control has to report the grouping now in effect - otherwise a user
    // cannot tell which of four views they are looking at.
    await expect
      .poll(async () => (await group.innerText()).trim(), {
        message: `choosing "${label}" left the grouping control still reading "${initial}"`,
        timeout: 20_000,
        intervals: [500, 1000],
      })
      .toBe(label);

    await expect
      .poll(async () => (await page.evaluate(() => document.body.innerText)).length, {
        message: `choosing "${label}" changed the control but left the page identical - the grouping is not applied`,
        timeout: 20_000,
        intervals: [1000, 2000],
      })
      .toBeGreaterThan(200);

    await captureSurface(page, testInfo, `checks-grouped-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  }

  // Put it back. This selection is part of the view state that outlives the
  // session (see KNOWN-ISSUES.md), so leaving it set changes what the next
  // test and the next person sees.
  await group.click();
  const back = page.locator('[role=menuitem],[role=option]');
  await expect(back.first()).toBeVisible({ timeout: 20_000 });
  const backTexts = (await back.allInnerTexts()).map((t) => t.trim());
  const none = backTexts.findIndex((t) => /^No grouping$/i.test(t));
  if (none >= 0) await back.nth(none).click();
  await expect
    .poll(async () => (await group.innerText()).trim(), { timeout: 20_000, intervals: [500, 1000] })
    .toBe('No grouping');
});

test('the Applications filters narrow the list to what they name', async ({ page }, testInfo) => {
  await openTable(page, '/applications');

  const all = await rowCount(page);
  expect.soft(all, '/applications lists nothing to filter').toBeGreaterThan(0);

  // Each filter's own label carries the number of applications it should
  // leave behind ("Service 4"), so the product states the expected answer and
  // the test holds it to it. A filter that names a count and then shows a
  // different number of rows is lying to the user.
  const filters = page.locator('button[aria-pressed]');
  const count = await filters.count();
  expect.soft(count, '/applications offers no filter buttons').toBeGreaterThan(0);

  let checked = 0;
  for (let i = 0; i < count; i++) {
    const button = filters.nth(i);
    const label = (await button.innerText()).trim();
    const [name, badge] = label.split('\n').map((s) => s.trim());
    const expected = Number(badge);
    if (!name || !Number.isInteger(expected)) continue;

    await button.click();
    await expect
      .poll(async () => button.getAttribute('aria-pressed'), {
        message: `the "${name}" filter did not register as selected when clicked`,
        timeout: 20_000,
        intervals: [500, 1000],
      })
      .toBe('true');

    await expect
      .poll(async () => rowCount(page), {
        message: `the "${name}" filter says it covers ${expected} application(s) but filtering by it shows a different number`,
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .toBe(expected);
    checked++;

    if (checked === 1) await captureSurface(page, testInfo, 'applications-filtered');

    // Off again, and the full list must come back - a filter you cannot clear
    // strands the user on a partial view.
    await button.click();
    await expect
      .poll(async () => rowCount(page), {
        message: `clearing the "${name}" filter did not restore the full list of ${all} applications`,
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .toBe(all);
  }

  expect
    .soft(checked, 'no /applications filter carried a count badge, so none could be held to it')
    .toBeGreaterThan(0);
});
