import { test, expect, type Page } from '@playwright/test';
import { adminEmail, captureSurface } from './helpers';

// Hub administration surface: Members, Audit log, Personal access tokens,
// and self-hosted license status. Unlike timeline.spec.ts / helm.spec.ts
// this is about the hub's own control plane, not data pulled from the
// connected cluster - so assertClusterConnected() doesn't apply here, none
// of these pages read anything through the radar tunnel.
//
// Dropped from scope, and why:
//  - Inviting a second member / accepting an invite: would need a second
//    mailbox or a throwaway account, and this suite must not touch the
//    shared admin's own membership or role (hard constraint). Not worth
//    faking.
//  - Renaming the org as the audit trigger: org.updated is a real owner-only
//    mutation on the one shared org every other agent is currently using -
//    changing its name mid-run would be visible to everyone else on the
//    stack. Minting/revoking a personal access token is scoped to this
//    session's own token and is exactly as auditable, so that's the trigger
//    used below.
//  - Sessions page (/settings/sessions): revoking a session risks revoking
//    the shared admin session other agents are using - explicitly
//    forbidden by the task.

/** GET /api/account and return the signed-in admin's current org id. */
async function currentOrgId(page: Page): Promise<string> {
  const res = await page.request.get('/api/account');
  expect(res.status(), 'account endpoint').toBe(200);
  const account = await res.json();
  expect(account.current_org_id, 'signed-in admin has no current_org_id').toBeTruthy();
  return account.current_org_id as string;
}

test('the bootstrap admin appears as a member with the owner role', async ({ page }, testInfo) => {
  await page.goto('/');
  const orgId = await currentOrgId(page);

  // Ground truth from the API first - if the UI and the API disagree, that's
  // a rendering bug, not a data bug, and the assertion messages below should
  // say which.
  const res = await page.request.get(`/api/orgs/${orgId}/members`);
  expect(res.status(), 'members endpoint').toBe(200);
  const members = await res.json();
  const adminMember = members.find((m: { email: string }) => m.email === adminEmail);
  expect(adminMember, `${adminEmail} is not in /api/orgs/${orgId}/members at all`).toBeTruthy();
  expect(adminMember.role, `${adminEmail} has role "${adminMember.role}", expected owner`).toBe('owner');

  await page.goto('/settings/organization/members');
  const table = page.getByRole('table').first();
  await expect(table, 'Members table never rendered').toBeVisible();

  const row = table.getByRole('row').filter({ hasText: adminEmail });
  await expect(row.first(), `no Members row for ${adminEmail}`).toBeVisible();
  await expect(
    row.first(),
    `Members page shows a row for ${adminEmail} but it doesn't say "owner"`,
  ).toContainText('owner');

  await captureSurface(page, testInfo, 'members-owner-role');
});

test(
  'minting and revoking a personal access token updates the token list and lands in the audit view',
  async ({ page }, testInfo) => {
    const orgId = await currentOrgId(page);

    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();

    // --- mint, via the UI ---
    // The panel defaults to the OAuth tab (it's the recommended path for
    // interactive agents); PAT is a sibling tab, not the default view.
    await page.getByRole('button', { name: 'Personal Access Token' }).click();
    await page.getByRole('button', { name: 'Generate token' }).click();

    // The post-mint reveal's name field id is `pat-name-<pat id>` - reading it
    // off the DOM gets us the real server-assigned id without having to poll
    // /api/pats and guess which row is ours (other agents may be minting
    // tokens in this same shared org at the same time).
    const nameInput = page.locator('input[id^="pat-name-"]');
    await expect(nameInput, 'post-mint token reveal never appeared after Generate token').toBeVisible();
    const patId = (await nameInput.getAttribute('id'))?.replace(/^pat-name-/, '');
    expect(patId, 'could not read the minted token id off the reveal panel').toBeTruthy();

    // Give the row a name unique to this run. "New token" alone would be
    // ambiguous in a table other agents may also be minting tokens into
    // right now; a timestamped name lets us find OUR row unambiguously.
    const tokenName = `e2e-settings-${Date.now()}`;
    await nameInput.fill(tokenName);
    await nameInput.press('Enter');

    const tokensTable = page.getByRole('table').first();
    const tokenRow = tokensTable.getByRole('row').filter({ hasText: tokenName });
    await expect(
      tokenRow.first(),
      `minted token "${tokenName}" never appeared in "Your connected agents"`,
    ).toBeVisible();

    await page.getByRole('button', { name: 'Dismiss' }).click();

    // --- causal link #1: the mint shows up in the audit VIEW ---
    // Before this point, target_id=patId cannot appear in the audit log
    // under any action - the id didn't exist until Generate token minted it
    // a moment ago. So finding it now, filtered to pat.created, is direct
    // proof this specific mint was recorded, not just "some pat.created
    // event landed" (which a concurrent agent's own mint could also produce).
    await page.goto('/settings/organization/audit');
    await page.getByLabel('Action').fill('pat.created');
    await page.getByRole('button', { name: 'Apply' }).click();
    const auditTable = page.getByRole('table').first();
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: 'Apply' }).click();
          return auditTable.getByText(patId!, { exact: false }).count();
        },
        {
          message: `no pat.created audit entry for token ${patId} - the mint never reached the audit log`,
          timeout: 20_000,
          intervals: [1000, 2000, 3000],
        },
      )
      .toBeGreaterThan(0);

    // --- revoke, via the UI ---
    await page.goto('/agents');
    const revokeRow = page.getByRole('table').first().getByRole('row').filter({ hasText: tokenName });
    await expect(revokeRow.first(), `token "${tokenName}" is missing from the list before revoke`).toBeVisible();
    await revokeRow.first().getByRole('button', { name: 'Revoke' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog, 'revoke confirmation dialog never opened').toBeVisible();
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();

    await expect(
      revokeRow.first().getByRole('button', { name: 'Revoke', exact: true }),
      `token "${tokenName}" still has a live Revoke control after confirming revoke`,
    ).toHaveCount(0);
    await expect(revokeRow.first(), `token "${tokenName}" list row doesn't read Revoked after revoking`).toContainText(
      'Revoked',
    );

    // --- causal link #2: the revoke shows up in the audit VIEW too ---
    await page.goto('/settings/organization/audit');
    await page.getByLabel('Action').fill('pat.revoked');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: 'Apply' }).click();
          return auditTable.getByText(patId!, { exact: false }).count();
        },
        {
          message: `no pat.revoked audit entry for token ${patId} - the revoke never reached the audit log`,
          timeout: 20_000,
          intervals: [1000, 2000, 3000],
        },
      )
      .toBeGreaterThan(0);

    // Evidence: the two audit rows this test caused, fetched straight from
    // the API so the attachment carries the real metadata (actor, ip, ua),
    // not just what happened to be visible on screen at attach-time.
    const auditRes = await page.request.get(
      `/api/orgs/${orgId}/audit?action=pat.created,pat.revoked&target_type=pat&limit=100`,
    );
    const auditBody = await auditRes.json();
    const causedByThisRun = (auditBody.events as Array<{ target_id?: string }>).filter(
      (e) => e.target_id === patId,
    );
    await testInfo.attach('pat-lifecycle-audit-events.json', {
      body: JSON.stringify(causedByThisRun, null, 2),
      contentType: 'application/json',
    });
    await captureSurface(page, testInfo, 'audit-pat-lifecycle');
  },
);

test('the self-hosting page reflects the license this deployment actually runs on', async ({ page }, testInfo) => {
  // /api/config is the one place the hub's own view of its license lives -
  // reading it here (rather than hardcoding org/cluster-cap/expiry) means
  // this test keeps passing if the license this stack runs on ever changes,
  // and fails honestly if the page stops reflecting whatever /api/config
  // says.
  const configRes = await page.request.get('/api/config');
  expect(configRes.status(), 'config endpoint').toBe(200);
  const config = await configRes.json();
  expect(config.mode, 'hub is not reporting self_hosted mode').toBe('self_hosted');
  const license = config.license;
  expect(license, 'GET /api/config reported no license block for a self-hosted hub').toBeTruthy();

  await page.goto('/settings/organization/self-hosting');
  await expect(page.getByRole('heading', { name: 'Self-hosting' })).toBeVisible();

  // The License card is the sibling <div> right after the "License" <h2> -
  // scope every assertion to it so a coincidental match elsewhere on the
  // page (e.g. the page subtitle mentions "license" too) can't hide a
  // missing value.
  const licenseCard = page
    .locator('h2', { hasText: 'License' })
    .locator('xpath=following-sibling::div[1]');
  await expect(licenseCard, 'License card never rendered').toBeVisible();

  // These fields are asserted to exist BEFORE being compared against the page.
  // Guarding each comparison behind `if (license.x)` would turn "the hub
  // stopped reporting the org / cluster cap / expiry" - a real regression -
  // into a test that quietly asserts nothing and still passes.
  expect(license.org, '/api/config reports no license org').toBeTruthy();
  expect(license.status, '/api/config reports no license status').toBeTruthy();
  expect(
    typeof license.max_clusters === 'number' && license.max_clusters > 0,
    `/api/config reports no cluster cap (max_clusters=${license.max_clusters})`,
  ).toBe(true);
  expect(license.expires_at, '/api/config reports no license expiry').toBeTruthy();

  await expect(
    licenseCard,
    `license is issued to "${license.org}" per /api/config but the card doesn't show it`,
  ).toContainText(license.org);
  await expect(
    licenseCard,
    `license caps this deployment at ${license.max_clusters} clusters per /api/config but the card doesn't say so`,
  ).toContainText(`up to ${license.max_clusters} clusters`);
  if (license.status === 'trial') {
    await expect(licenseCard, 'license status is "trial" but the card headline does not say Trial').toContainText(
      'Trial',
    );
  }
  {
    // Same formatting the page itself uses (SelfHosting.tsx's fmtDate:
    // toLocaleDateString(undefined, {month:'long',day:'numeric',year:'numeric'})).
    // Pinned to en-US here rather than the Node process's locale (which
    // depends on the machine running the test, not the browser rendering
    // the page) - Playwright's Chromium defaults to en-US regardless of host.
    const expiry = new Date(license.expires_at);
    const formatted = expiry.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    await expect(
      licenseCard,
      `license expires ${license.expires_at} per /api/config but the card doesn't show "${formatted}"`,
    ).toContainText(formatted);
  }

  await captureSurface(page, testInfo, 'self-hosting-license');
});
