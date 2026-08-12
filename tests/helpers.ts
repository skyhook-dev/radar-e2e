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
  const base = kubeContext ? ['--context', kubeContext] : [];
  return execFileSync('kubectl', [...base, ...args], { encoding: 'utf8' }).trim();
}

/** Same idea for helm: the expected releases come from the cluster, not a fixture. */
export function helm(...args: string[]): string {
  const base = kubeContext ? ['--kube-context', kubeContext] : [];
  return execFileSync('helm', [...base, ...args], { encoding: 'utf8' }).trim();
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
