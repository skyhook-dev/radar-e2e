import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

// Standalone OSS radar has no login, no org, no cluster switching - it is one
// process pointed at one kubeconfig context. That is the whole difference
// from the hub suite this harness's conventions are borrowed from: no
// clusterId, no auth, no /c/{id} URL prefix. Everything else - reading truth
// from kubectl instead of a fixture, screenshot naming, animation handling -
// carries over unchanged.

const kubeconfigPath = process.env.RADAR_KUBECONFIG ?? '';
const kubeContext = process.env.KUBE_CONTEXT ?? '';

/** Run kubectl against the harness's own kind cluster - never the caller's default context. */
export function kubectl(...args: string[]): string {
  const base = kubeconfigPath ? ['--kubeconfig', kubeconfigPath] : [];
  const ctx = kubeContext ? ['--context', kubeContext] : [];
  return execFileSync('kubectl', [...base, ...ctx, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Poll GET /api/health until the informer cache reports healthy.
 *
 * Standalone radar has no "cluster connected" concept to check like the hub
 * suite's `/api/clusters` - there is exactly one cluster, and the process
 * either has a live K8s cache or it doesn't. `/api/health` is the same probe
 * radar's own startup SSE progress ultimately resolves to: cache present,
 * status "healthy". A page load before this point renders "Not connected to
 * cluster" (503) from almost every API route, which looks identical to a
 * genuinely broken feature - so every spec waits here first.
 */
export async function assertClusterConnected(page: Page) {
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/health');
        if (res.status() !== 200) return `http ${res.status()}`;
        const body = (await res.json()) as { status?: string; resourceCount?: number };
        return body.status === 'healthy' ? 'healthy' : `status=${body.status}`;
      },
      {
        message: 'radar never reported /api/health status=healthy - the informer cache against the kind cluster never came up',
        timeout: 60_000,
        intervals: [500, 1000, 2000, 3000],
      },
    )
    .toBe('healthy');
}

/**
 * Capture a reviewable screenshot at a meaningful moment.
 *
 * Naming follows `<surface>-<state>` so a shared gallery job can pair the
 * same surface across suites. Kept in lockstep with the hub suite's
 * `captureSurface` (same options, same dark-theme probe, same on-disk shape)
 * so a future gallery can display both side by side.
 */
export async function captureSurface(
  page: Page,
  testInfo: { attach: (name: string, opts: { body: Buffer; contentType: string }) => Promise<void> },
  name: string,
  target?: Locator,
): Promise<void> {
  // animations: 'disabled' finishes CSS transitions before capturing - a
  // fading element still counts as "visible" to Playwright, which produces a
  // blank screenshot even though every assertion passed. caret: 'hide' keeps
  // a blinking cursor out of diffs.
  const opts = { animations: 'disabled', caret: 'hide' } as const;
  const shoot = () =>
    target ? target.screenshot({ ...opts }) : page.screenshot({ ...opts, fullPage: true });

  const dir = process.env.VISUAL_DIR ?? path.join(__dirname, '..', 'visual');
  fs.mkdirSync(dir, { recursive: true });

  const save = async (suffix: string, body: Buffer) => {
    fs.writeFileSync(path.join(dir, `${name}${suffix}.png`), body);
    await testInfo.attach(`${name}${suffix}.png`, { body, contentType: 'image/png' });
  };

  await save('', await shoot());

  // Same surface in dark theme, emulated via prefers-color-scheme rather than
  // a UI toggle - there is no account/server-side preference to avoid
  // touching here (no auth), but emulation is still the only way to get dark
  // mode without depending on the OS the test happens to run on.
  await page.emulateMedia({ colorScheme: 'dark' });
  const wentDark = await page
    .waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (wentDark) {
    await save('__dark', await shoot());
  } else {
    await testInfo.attach(`${name}__dark-skipped.txt`, {
      body: Buffer.from(
        'Dark theme was not captured: emulating prefers-color-scheme: dark did not put the app into dark mode.',
      ),
      contentType: 'text/plain',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * The Resources page has THREE <nav> landmarks: the app's primary sidebar
 * (Home/Resources/Topology/...), its Settings footer, and the per-kind
 * resource browser sidebar (WORKLOADS/NETWORKING/... with the count badges).
 * A plain `page.locator('nav')` is ambiguous between all three - scope by
 * content ("WORKLOADS" only appears in the resource-kind nav) rather than by
 * position, so a future reorder of the sidebars doesn't silently break this.
 */
export function resourceKindNav(page: Page): Locator {
  return page.locator('nav').filter({ hasText: 'WORKLOADS' });
}

/**
 * Reads a kind's count badge from the Resources sidebar. Label and count are
 * separate text nodes inside the same button, so the accessible name comes
 * out as "<Kind> <count>" once loaded (or "<Kind> –" while a count is still
 * unavailable, which parses to NaN and lets the caller's poll keep waiting
 * instead of matching a false zero).
 */
export function sidebarKindButton(page: Page, kind: string): Locator {
  return resourceKindNav(page).getByRole('button', { name: new RegExp(`^${kind}\\b`) }).first();
}

export async function sidebarKindCount(page: Page, kind: string): Promise<number> {
  const button = sidebarKindButton(page, kind);
  await expect(button).toBeVisible();
  const parts = (await button.innerText()).trim().split(/\s+/).filter(Boolean);
  return Number(parts[parts.length - 1]);
}

/**
 * Collect browser console errors for the life of a test. A page can look
 * correct in a screenshot while throwing - attach the result so a reviewer
 * sees it beside the image instead of it being a silent footnote.
 */
export function watchConsoleErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  return () => errors;
}
