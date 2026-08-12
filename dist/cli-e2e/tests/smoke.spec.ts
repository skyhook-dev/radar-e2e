import { test, expect } from '@playwright/test';
import { assertClusterConnected, captureSurface, watchConsoleErrors } from './helpers';

// Milestone 1: the installed binary serves a working UI at all, against a
// real cluster. Every other spec assumes this already works - if it
// doesn't, this is the one that should go red, with a screenshot of
// whatever actually rendered instead of an app shell.

test('the app loads and connects to the cluster', async ({ page }, testInfo) => {
  const consoleErrors = watchConsoleErrors(page);

  await page.goto('/');
  // The sidebar nav only renders once the app shell has mounted - a much
  // stronger signal than "the page returned 200", which a blank error
  // boundary would also satisfy.
  await expect(page.getByRole('button', { name: 'Resources', exact: true })).toBeVisible();

  await assertClusterConnected(page);
  await captureSurface(page, testInfo, 'app-shell-connected');

  const errors = consoleErrors();
  if (errors.length) {
    await testInfo.attach('first-load-console-errors.json', {
      body: JSON.stringify(errors, null, 2),
      contentType: 'application/json',
    });
  }
});
