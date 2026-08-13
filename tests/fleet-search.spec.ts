import { test, expect, type Page } from '@playwright/test';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  gotoWhenNotRateLimited,
  kubectl,
  waitForFleetReporting,
} from './helpers';

// The search box in the header - the fastest way into anything, and untested.
//
// It sits on every page, it is bound to the keyboard, and it is what an
// operator reaches for when someone says "have a look at storefront". It
// searches across kinds and across clusters, and its results carry the
// attribution that makes them useful: kind, namespace and which cluster.
//
// Two things are checked, and the second matters as much as the first:
//
//   1. It FINDS what the cluster actually has. The fixture namespace holds a
//      Deployment, a Service, a ConfigMap and a Secret that share a name
//      prefix, so one query should surface several kinds - and the expected
//      answer comes from `kubectl get`, not from a list written here.
//   2. It does NOT invent. A query for something that does not exist has to
//      come back empty. A search that always shows plausible results is worse
//      than one that finds nothing, because it is trusted.
//
// Read off the running product before being written: typing a name renders a
// RESOURCES section whose entries read "<name>" then "<Kind> · <namespace> ·
// <cluster>", and the panel closes on Escape.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

const FIXTURE_NS = process.env.FIXTURE_NS ?? 'e2e-fixtures';
const PREFIX = 'storefront';

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

function searchBox(page: Page) {
  return page.getByPlaceholder(/Search resources across your fleet/i).first();
}

/** What the cluster really has under this prefix, as "<kind>|<name>". */
function clusterMatches(prefix: string): { kind: string; name: string }[] {
  const found: { kind: string; name: string }[] = [];
  for (const [kind, arg] of [
    ['Deployment', 'deployments'],
    ['Service', 'services'],
    ['ConfigMap', 'configmaps'],
  ] as const) {
    const names = kubectl('get', arg, '-n', FIXTURE_NS, '-o', 'name')
      .split('\n')
      .map((l) => l.trim().split('/').pop() ?? '')
      .filter((n) => n.startsWith(prefix));
    for (const name of names) found.push({ kind, name });
  }
  return found;
}

/** The RESOURCES panel's text, or '' when it is not open. */
async function panelText(page: Page): Promise<string> {
  const text = await bodyText(page);
  const i = text.indexOf('RESOURCES');
  return i < 0 ? '' : text.slice(i);
}

/**
 * How many results the panel is showing.
 *
 * Every result line carries "<Kind> · <namespace> · <cluster>", so counting
 * the middle dot counts results without depending on any particular wording.
 * The header alone ("RESOURCES | search all | esc close") contains none.
 */
async function resultCount(page: Page): Promise<number> {
  return (await panelText(page)).split('\n').filter((l) => l.includes('·')).length;
}

async function search(page: Page, term: string): Promise<string> {
  const box = searchBox(page);
  await expect(box, 'the fleet search box is not on the page').toBeVisible({ timeout: 45_000 });
  await box.click();
  await box.fill('');

  // Typed key by key rather than filled. fill() sets the value in one shot and
  // this box never queries: nothing reaches /api/fleet/search and the panel
  // stays on its placeholder, which reads exactly like a search that finds
  // nothing. Typing produces one request per keystroke, as a user would.
  await box.pressSequentially(term, { delay: 60 });

  // Settle on the panel rather than a fixed pause: results arrive per
  // keystroke, so the last response is the one that matters.
  let last = -1;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const now = await resultCount(page);
    if (now > 0 && now === last) break;
    last = now;
  }
  return panelText(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await gotoWhenNotRateLimited(page, '/');
  // Connected is not the same as answering. Without this, a run where the
  // agent is attached but silent reports "search does not find what is in the
  // cluster" - which is true, and blames the wrong thing.
  await waitForFleetReporting(page);
});

test('fleet search finds the resources this cluster really has, across kinds', async ({ page }, testInfo) => {
  const expected = clusterMatches(PREFIX);
  expect(
    expected.length,
    `the fixture namespace ${FIXTURE_NS} has nothing starting with "${PREFIX}", so this test cannot mean anything`,
  ).toBeGreaterThan(1);

  const text = await search(page, PREFIX);
  await captureSurface(page, testInfo, 'fleet-search-results');

  for (const { kind, name } of expected) {
    // Soft per resource, so one missing kind does not hide the others.
    expect
      .soft(
        text,
        `fleet search for "${PREFIX}" does not offer the ${kind} ${FIXTURE_NS}/${name}, which is in the cluster`,
      )
      .toContain(name);
  }

  // Results have to say what they are and where they live, or an operator
  // cannot tell two same-named resources apart.
  expect
    .soft(text, 'fleet search results do not say which namespace each match lives in')
    .toContain(FIXTURE_NS);
  expect
    .soft(text, 'fleet search results do not name a kind, so a Service and a Deployment look identical')
    .toMatch(/Deployment|Service|ConfigMap/);
});

test('fleet search does not invent results for something that is not there', async ({ page }) => {
  const nonsense = `zzz-not-a-real-resource-${Date.now()}`;
  await search(page, nonsense);

  // Counted, not string-matched: the panel legitimately echoes the query back,
  // so looking for the query text in the panel would fail on a search that is
  // behaving perfectly.
  expect(
    await resultCount(page),
    `fleet search offered matches for "${nonsense}", which exists in no cluster - a search that always finds ` +
      `something cannot be trusted when it matters`,
  ).toBe(0);
});
