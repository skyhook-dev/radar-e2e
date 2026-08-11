import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

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
