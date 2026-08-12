import { test, expect } from '@playwright/test';
import { adminEmail, captureSurface, signInAsAdmin, watchConsoleErrors } from './helpers';

// Milestone 1: prove the harness can reach a licensed, working hub and get a
// real authenticated session through the UI. Every later scenario starts from
// a signed-in page, so if this fails there is no point running the rest.

test.describe('sign-in', () => {
  // This spec is about the login itself, so it starts signed out rather than
  // reusing the shared session.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('break-glass admin signs in and lands in the app', async ({ page }, testInfo) => {
    const consoleErrors = watchConsoleErrors(page);

    // Signed-out login page: the first surface anyone sees, and the one that
    // shows the license gate when a license expires - worth a picture on every
    // run even when it passes.
    await page.goto('/');
    // Wait for the form itself, not just the route: capturing straight after
    // navigation caught the brand mark mid-render with no form on screen -
    // a picture that shows nothing and would quietly stay useless forever.
    await expect(
      page.locator('form').filter({ has: page.locator('input[type="password"]') }),
    ).toBeVisible();
    await captureSurface(page, testInfo, 'login-signed-out');

    await signInAsAdmin(page);

    // Authenticated app shell, not just "left the login page": the nav only
    // renders inside RequireAuth.
    await expect(page.getByRole('link', { name: 'Clusters', exact: true })).toBeVisible();
    await expect(page.getByText(adminEmail)).toBeVisible();

    await captureSurface(page, testInfo, 'app-shell-signed-in');
    const errors = consoleErrors();
    if (errors.length) {
      await testInfo.attach('sign-in-console-errors.json', {
        body: JSON.stringify(errors, null, 2),
        contentType: 'application/json',
      });
    }
  });
});

test('the session is backed by a seeded org', async ({ page }) => {
  // A self-hosted hub starts with no orgs and seeds a singleton one from the
  // license `org` claim on the first bootstrap-admin sign-in. Without that org
  // the UI still renders but every cluster call would be org-less, so assert it
  // directly rather than inferring it from a screen.
  await page.goto('/');

  const account = await page.request.get('/api/account');
  expect(account.status()).toBe(200);
  const body = await account.json();
  expect(body.email).toBe(adminEmail);
  expect(body.current_org_id, 'no org seeded for the bootstrap admin').toBeTruthy();
});
