import { test as setup } from '@playwright/test';
import { authStatePath, signInAsAdmin } from './helpers';

// The hub rate-limits the break-glass login to 5 attempts per minute per IP
// (it is the only password surface in a self-hosted install). Signing in once
// here and sharing the session keeps the suite well under that as it grows -
// a per-test login starts failing with "Too Many Requests" around the fifth
// test, which looks like a product bug and is not one.
setup('authenticate once', async ({ page }) => {
  await signInAsAdmin(page);
  await page.context().storageState({ path: authStatePath });
});
