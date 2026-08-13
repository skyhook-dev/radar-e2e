import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

/** Where the shared signed-in session is cached (see auth.setup.ts). */
export const authStatePath = path.join(__dirname, '..', '.run', 'auth.json');

export const adminEmail = process.env.E2E_ADMIN_EMAIL ?? '';
export const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? '';
export const clusterId = process.env.CLUSTER_ID ?? '';
export const demoNamespace = process.env.DEMO_NS ?? 'e2e-demo';
export const demoDeployment = process.env.DEMO_DEPLOY ?? 'timeline-probe';

const kubeContext = process.env.KUBE_CONTEXT ?? '';

/**
 * Run kubectl against the harness cluster. The timeline specs need to CAUSE a
 * cluster change, not just read one - an assertion over pre-existing events
 * would pass against a stale store and prove nothing about the live path.
 */
export function kubectl(...args: string[]): string {
  requireKubeContext();
  return execFileSync('kubectl', ['--context', kubeContext, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Refuse to touch a cluster nobody named.
 *
 * These specs CREATE things - namespaces, broken deployments, TLS secrets -
 * and without an explicit context kubectl uses whatever happens to be current.
 * That is not hypothetical: a parallel piece of work switched the current
 * context to its own kind cluster mid-run, and this suite went and created its
 * fixture namespace in someone else's cluster while every browser assertion
 * carried on passing against the right hub. run.sh always sets KUBE_CONTEXT;
 * an ad-hoc `npx playwright test` does not.
 */
function requireKubeContext() {
  if (!kubeContext) {
    throw new Error(
      'KUBE_CONTEXT is not set. These specs create resources in a cluster - refusing to use whatever ' +
        'kubectl context happens to be current. Run through run.sh, or set KUBE_CONTEXT explicitly.',
    );
  }
}

/** Same idea for helm: the expected releases come from the cluster, not a fixture. */
export function helm(...args: string[]): string {
  requireKubeContext();
  return execFileSync('helm', ['--kube-context', kubeContext, ...args], { encoding: 'utf8' }).trim();
}

export type HelmRelease = { name: string; namespace: string; chart: string; status: string };

export function installedHelmReleases(): HelmRelease[] {
  return JSON.parse(helm('list', '--all-namespaces', '-o', 'json')) as HelmRelease[];
}

export function requireAdminCredentials() {
  if (!adminEmail || !adminPassword) {
    throw new Error('E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD must be set');
  }
}

/**
 * Sign in as the break-glass admin. It is the only login that works without an
 * identity provider, so every scenario starts here.
 *
 * An unlicensed hub serves the license screen in place of the login form. Both
 * surfaces are awaited together so that case reports itself as "the hub is
 * license-gated" rather than as a login form that never appeared - an expired
 * license is the likeliest reason for this suite to start failing on its own.
 */
export async function signInAsAdmin(page: Page) {
  requireAdminCredentials();
  await page.goto('/');

  const loginForm = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  const licenseScreen = page.getByText(/needs a license to start|license has expired/i);
  await expect(loginForm.or(licenseScreen).first()).toBeVisible();
  if (await licenseScreen.isVisible()) {
    throw new Error('hub is license-gated: RADAR_HUB_LICENSE is missing, invalid, or expired');
  }

  // Fields are targeted by type, not by placeholder copy: the wording is
  // product-owned and changes, the field types do not.
  await loginForm.locator('input[type="email"]').fill(adminEmail);
  await loginForm.locator('input[type="password"]').fill(adminPassword);
  await loginForm.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Fail early, and differently, when the cluster is not connected. Without this
 * a dead tunnel and a broken timeline both surface as "no events" - and the
 * two want completely different follow-up.
 */
export async function assertClusterConnected(page: Page) {
  const res = await page.request.get('/api/clusters');
  expect(res.status(), 'clusters endpoint').toBe(200);
  const cluster = (await res.json()).find((c: { id: string }) => c.id === clusterId);
  expect(cluster, `cluster ${clusterId} is not registered with the hub`).toBeTruthy();
  expect(
    cluster.status,
    `cluster ${clusterId} is ${cluster.status}, not connected - the tunnel is down, so the timeline cannot be reached`,
  ).toBe('connected');
}

/**
 * Capture a reviewable screenshot at a meaningful moment.
 *
 * Naming follows the visual-test convention: `<surface>-<state>` (for example
 * `clusters-list-connected`, `install-wizard-helm-cmd`) so the gallery can pair
 * the same surface across the main and published variants and a human can tell
 * what they are looking at without opening the spec.
 *
 * Pass a locator for drawers, dialogs and dropdowns: an element shot of the
 * thing that changed carries far less noise than a full page of chrome around
 * it, which is what makes a diff readable.
 */
export async function captureSurface(
  page: Page,
  testInfo: { attach: (name: string, opts: { body: Buffer; contentType: string }) => Promise<void> },
  name: string,
  target?: Locator,
): Promise<void> {
  // animations: 'disabled' finishes CSS transitions before capturing. Without
  // it this suite photographed the login page mid fade-in - Playwright counts a
  // fading element as visible, so the assertion passed while the picture showed
  // an almost-empty screen. caret: 'hide' keeps a blinking cursor out of diffs.
  const opts = { animations: 'disabled', caret: 'hide' } as const;
  const shoot = () =>
    target ? target.screenshot({ ...opts }) : page.screenshot({ ...opts, fullPage: true });

  // Written to disk as well as attached. The attachment is for the HTML report;
  // the file is what the gallery job collects, because a plain tree of
  // meaningfully-named PNGs is far easier to pair across variants than the
  // report's content-hashed internals - and it exists locally too, where the
  // list reporter keeps no attachments at all.
  const dir = process.env.VISUAL_DIR ?? path.join(__dirname, '..', 'visual');
  fs.mkdirSync(dir, { recursive: true });

  const save = async (suffix: string, body: Buffer) => {
    fs.writeFileSync(path.join(dir, `${name}${suffix}.png`), body);
    await testInfo.attach(`${name}${suffix}.png`, { body, contentType: 'image/png' });
  };

  await save('', await shoot());

  // Same surface in dark theme. ThemeProvider resolves `system` mode from
  // prefers-color-scheme and applies it by toggling a `dark` class on the root,
  // so emulating the media query flips the theme WITHOUT touching the user's
  // stored preference - which is server-side and shared, and would leak into
  // every other test if we toggled it through the UI.
  await page.emulateMedia({ colorScheme: 'dark' });
  const wentDark = await page
    .waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (wentDark) {
    await save('__dark', await shoot());
  } else {
    // Do NOT save a duplicate image labelled "dark": a reviewer would believe
    // dark mode had been reviewed when it had not. Record why instead - the
    // usual cause is the account's theme being pinned to light rather than
    // following the system.
    await testInfo.attach(`${name}__dark-skipped.txt`, {
      body: Buffer.from(
        'Dark theme was not captured: emulating prefers-color-scheme: dark did not put the app into ' +
          'dark mode, so the stored theme preference is probably pinned rather than following the system.',
      ),
      contentType: 'text/plain',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * Collect browser console errors for the life of a test.
 *
 * The visual-test methodology treats console errors as a first-class result,
 * not a footnote: a page can look perfectly correct in a screenshot while
 * throwing. Attach the result so the gallery can show it beside the image.
 */
export function watchConsoleErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  return () => errors;
}

/** Panel text that means the view failed rather than rendered. */
const BROKEN_PANEL = /something went wrong|failed to load|unable to load|unexpected error/i;

export type TabWalkResult = {
  /** Tab label -> the page text it rendered, for callers wanting extra checks. */
  rendered: Map<string, string>;
  /** Labels in the order the product offered them. */
  offered: string[];
};

/**
 * Open every tab a view offers and check each one, without stopping at the
 * first broken one.
 *
 * A scenario that opens one tab and moves on leaves the rest never exercised:
 * a tab that throws, renders blank or spins forever fails nothing. Standing up
 * a cluster costs minutes, so once a view is on screen the cheap thing is to
 * walk all of it.
 *
 * Everything here is `expect.soft` on purpose. A hard assertion stops at the
 * first bad tab, so you fix that one, re-run, and discover the next - the worst
 * possible shape for a sweep. Soft assertions report every broken tab in one
 * pass and still fail the test at the end.
 *
 * What each tab is held to, and why:
 *   - it becomes selected, so a click that does nothing is not read as success
 *   - it renders a non-trivial amount of text, so a blank panel is caught
 *   - it is not showing an error or still loading
 *   - it renders something DIFFERENT from every other tab, which catches a
 *     label that does nothing without needing to know any tab's copy
 *
 * Tab labels carry their badge with no separator ("Timeline32"), so the label
 * is cut at the first non-letter rather than split on whitespace.
 */
export async function walkTabs(
  page: Page,
  testInfo: Parameters<typeof captureSurface>[1],
  surfacePrefix: string,
): Promise<TabWalkResult> {
  const tablist = page.getByRole('tablist').first();
  await expect(tablist, `${surfacePrefix}: no tab strip appeared`).toBeVisible({ timeout: 30_000 });

  const offered = (await page.getByRole('tab').allTextContents())
    .map((t) => (t.trim().match(/^[A-Za-z][A-Za-z ]*/)?.[0] ?? '').trim())
    .filter(Boolean);
  expect(offered.length, `${surfacePrefix}: the view offered no tabs at all`).toBeGreaterThan(0);
  testInfo.annotations.push({ type: `tabs:${surfacePrefix}`, description: offered.join(', ') });

  const rendered = new Map<string, string>();
  for (const label of offered) {
    const tab = page.getByRole('tab', { name: new RegExp(`^\\s*${label}`, 'i') }).first();
    await tab.click();

    await expect
      .soft(tab, `${surfacePrefix}: the ${label} tab did not become selected when clicked`)
      .toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

    const text = (await page.locator('body').innerText()).trim();
    expect
      .soft(text.length, `${surfacePrefix}: the ${label} tab rendered almost no text (${text.length} chars)`)
      .toBeGreaterThan(200);

    await expect
      .soft(page.getByText(BROKEN_PANEL).first(), `${surfacePrefix}: the ${label} tab rendered an error state`)
      .toBeHidden({ timeout: 10_000 });

    await expect
      .soft(
        page.getByText(/^\s*(loading|fetching)/i).first(),
        `${surfacePrefix}: the ${label} tab was still loading after 10s - a stuck spinner looks identical to a working tab in a screenshot`,
      )
      .toBeHidden({ timeout: 10_000 });

    await captureSurface(page, testInfo, `${surfacePrefix}-tab-${label.toLowerCase().replace(/\s+/g, '-')}`);
    rendered.set(label, text);
  }

  const byText = new Map<string, string>();
  for (const [label, text] of rendered) {
    const twin = byText.get(text);
    expect
      .soft(twin, `${surfacePrefix}: the ${label} tab renders exactly the same content as the ${twin} tab - selecting it changes nothing`)
      .toBeUndefined();
    byText.set(text, label);
  }

  return { rendered, offered };
}

/**
 * Navigate to a page and wait until it has actually loaded its data.
 *
 * The hub's fleet endpoints share a per-user budget (30/min). A run that walks
 * several domains in a row exhausts it, and the pages then render an explicit
 * error - "Failed to load checks: Too Many Requests" - instead of their
 * content. In that state the page's own controls are genuinely absent, so any
 * assertion about them reports a missing feature when the truth is that the
 * test asked too often. The product is behaving correctly; the test has to
 * wait its turn.
 *
 * Reloads rather than just polling: the page fetches once on mount and the
 * error is terminal for that render.
 */
export async function gotoWhenNotRateLimited(page: Page, path: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  const rateLimited = async () =>
    /Too Many Requests|rate limit/i.test(await page.evaluate(() => document.body.innerText).catch(() => ''));

  await page.goto(path);
  for (;;) {
    // Checked twice, a beat apart. A page can render its shell cleanly and
    // only then have one of its own fetches come back 429, so a single check
    // straight after navigation clears a page that is about to show an error.
    if (!(await rateLimited())) {
      await page.waitForTimeout(2000);
      if (!(await rateLimited())) return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${path} was still rate limited after ${Math.round(timeout / 1000)}s - the fleet endpoints never ` +
          `served this page, so nothing on it can be judged`,
      );
    }
    await page.waitForTimeout(5000);
    await page.reload();
  }
}
