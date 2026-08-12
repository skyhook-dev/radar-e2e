import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { adminEmail } from './helpers';

// Hub administration surfaces NOT already covered by settings.spec.ts
// (members, audit log, PATs, self-hosted license): invitations, personal
// preferences, and the in-app notification inbox.
//
// Dropped from scope, and why:
//  - Domains / SSO: GET /api/orgs/{id}/domains returns [] and GET .../sso
//    returns "sso not available" on this stack - this hub runs with
//    auth.workos=false (see GET /api/config), and domain verification is a
//    WorkOS-backed feature (internal/server/api.go's handleAddOrgDomain
//    pushes to WorkOS). There is nothing live to assert beyond "the feature
//    is off", and exercising add/verify would either no-op against a
//    provider that isn't configured or fail in a way that says nothing
//    about the product.
//  - Checks settings (GET/PATCH /api/checks/config): the config is org-wide
//    and other specs' Checks/audit-posture assertions may run against it
//    concurrently on this shared stack; mutating it risks changing what
//    those scenarios see, which the task explicitly rules out. Issues
//    settings below is read-only for the same reason - it proves the page
//    renders the real policy without touching it.
//  - Notification destinations (Slack/webhook) and per-rule alert routing:
//    those are alerting configuration, already exercised by whatever
//    creates the alert-driven inbox rows this spec reads; adding a
//    throwaway webhook destination here would be surface duplication, not
//    new coverage.

/** GET /api/account and return the signed-in admin's current org id. */
async function currentOrgId(page: Page): Promise<string> {
  const res = await page.request.get('/api/account');
  expect(res.status(), 'account endpoint').toBe(200);
  const account = await res.json();
  expect(account.current_org_id, 'signed-in admin has no current_org_id').toBeTruthy();
  return account.current_org_id as string;
}

/** GET /api/orgs and return this org's real, live name - never hardcoded. */
async function currentOrgName(page: Page, orgId: string): Promise<string> {
  const res = await page.request.get('/api/orgs');
  expect(res.status(), 'orgs endpoint').toBe(200);
  const orgs = (await res.json()) as Array<{ id: string; name: string }>;
  const org = orgs.find((o) => o.id === orgId);
  expect(org, `org ${orgId} is not in GET /api/orgs`).toBeTruthy();
  return org!.name;
}

const hubUrl = process.env.HUB_URL ?? 'http://localhost:18080';

test(
  'an owner can invite a teammate; the unauthenticated preview shows the real org and role, and a mismatched-email account is refused without being told who the invite was for',
  async ({ page }, testInfo) => {
    const orgId = await currentOrgId(page);
    const orgName = await currentOrgName(page, orgId);

    // A non-default role (org's default_invite_role is "member" on this
    // stack) so the preview assertion below proves the role that was
    // actually submitted, not just whatever the default happens to be.
    const inviteEmail = `e2e-org-admin-invitee-${Date.now()}@example.com`;
    const inviteRole = 'Viewer';

    await page.goto('/settings/organization/members');
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();

    await page.getByPlaceholder('teammate@company.com').fill(inviteEmail);
    await page.getByRole('combobox', { name: 'Invitation role' }).click();
    await page.getByRole('option').filter({ hasText: inviteRole }).first().click();

    const createResponsePromise = page.waitForResponse(
      (res) => res.url().includes(`/api/orgs/${orgId}/invitations`) && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create invite' }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status(), 'creating an invitation via the UI').toBe(201);
    const invitation = await createResponse.json();
    const code: string = invitation.id;
    expect(code, 'create-invitation response has no id').toBeTruthy();
    expect(invitation.email, 'create-invitation response echoes the wrong email').toBe(inviteEmail);
    expect(invitation.role, 'create-invitation response echoes the wrong role').toBe('viewer');

    await expect(
      page.getByText(`Invite created for ${inviteEmail}`),
      'the members page never confirmed the invite it just created',
    ).toBeVisible();

    await testInfo.attach('invite-created.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    try {
      // ---- unauthenticated preview: real "no session" context, not the
      // shared admin's storageState (that's the trap this suite was bitten
      // by before - see the task's hard-constraints note). ----
      const anonApi = await playwrightRequest.newContext({
        baseURL: hubUrl,
        storageState: { cookies: [], origins: [] },
      });
      try {
        const anonAccountRes = await anonApi.get('/api/account');
        expect(anonAccountRes.status(), 'a genuinely unauthenticated context must not resolve an account').toBe(401);

        const previewRes = await anonApi.get(`/api/invitations/${code}`);
        expect(previewRes.status(), 'unauthenticated preview of a freshly created invite').toBe(200);
        const preview = await previewRes.json();
        expect(preview.org_name, 'preview does not name the real org').toBe(orgName);
        expect(preview.role, 'preview does not carry the role it was created with').toBe('viewer');
        expect(preview.email, 'preview does not carry the invited email').toBe(inviteEmail);
        expect(preview.accepted, 'a fresh invitation must not preview as already accepted').toBe(false);
      } finally {
        await anonApi.dispose();
      }

      // ---- negative: an account whose email does NOT match the invite
      // tries to accept it. ----
      //
      // This hub runs with dev-bypass auth OFF (confirmed: no HUB_DEV_BYPASS
      // env on the deployment, and both the "user:<email>" cookie AND the
      // "Authorization: Bearer user:<email>" form 401 on /api/account here -
      // POST /api/auth/dev-signin itself returns 200 and writes a user row,
      // but the session it hands back can never authenticate anything on
      // this deployment). WorkOS is also off (GET /api/config: auth.workos =
      // false). Break-glass is the only working credential, and it is
      // pinned to one email - so there is no way in this environment to
      // stand up a second, independently-authenticated real identity.
      //
      // The admin's own already-authenticated session is itself a perfectly
      // real account whose email doesn't match a freshly-generated,
      // never-used invitee address - so it exercises the exact same
      // server-side check (db.AcceptInvitation's email comparison) that a
      // genuine second user would hit, without fabricating a session the
      // hub won't actually honor.
      expect(adminEmail, 'admin email must differ from the invited email for this negative case to mean anything').not.toBe(
        inviteEmail,
      );
      const acceptRes = await page.request.post(`/api/invitations/${code}/accept`, {
        headers: { 'X-Hub-Auth': '1' },
      });
      expect(
        acceptRes.status(),
        'an account whose email does not match the invited address must not be able to accept it',
      ).toBe(403);
      const acceptBody = (await acceptRes.text()).toLowerCase();
      expect(acceptBody, 'the refusal message must not confirm which email the invite targeted').not.toContain(
        inviteEmail.toLowerCase(),
      );
      expect(acceptBody, 'refusal message should read as a generic mismatch, not a raw error').toContain(
        'different account',
      );

      // And the invite must still be unaccepted after the failed attempt,
      // proving the rejection didn't silently consume it.
      const stillPendingRes = await page.request.get(`/api/invitations/${code}`);
      expect((await stillPendingRes.json()).accepted, 'a rejected accept attempt must not consume the invite').toBe(
        false,
      );
    } finally {
      // ---- cleanup: revoke, as the owner, regardless of what failed above. ----
      const revokeRes = await page.request.delete(`/api/orgs/${orgId}/invitations/${code}`, {
        headers: { 'X-Hub-Auth': '1' },
      });
      expect(revokeRes.status(), 'revoking the invitation this test created').toBe(204);

      const goneRes = await page.request.get(`/api/orgs/${orgId}/invitations`);
      const remaining = (await goneRes.json()) as Array<{ id: string }>;
      expect(
        remaining.some((inv) => inv.id === code),
        'the revoked invitation is still listed for the org',
      ).toBe(false);
    }
  },
);

test(
  'changing the theme preference persists past a fresh page load and is reflected by the hub API, then is restored',
  async ({ page }, testInfo) => {
    // Ground truth BEFORE any mutation, so restoration in `finally` always
    // has a real value to go back to - other agents share this account.
    const baselineRes = await page.request.get('/api/preferences');
    expect(baselineRes.status(), 'GET /api/preferences baseline').toBe(200);
    const originalTheme = (await baselineRes.json()).theme as string; // '' | 'light' | 'dark'

    const originalMode = originalTheme === '' ? 'system' : originalTheme;
    const nextMode = originalMode === 'system' ? 'dark' : originalMode === 'dark' ? 'light' : 'system';
    const nextTheme = nextMode === 'system' ? '' : nextMode;
    const label = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

    try {
      await page.goto('/settings/preferences');
      await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

      const themeSelect = page.getByRole('combobox', { name: 'Theme' });
      await expect(themeSelect, 'theme selector never rendered').toBeVisible();
      await expect(
        themeSelect,
        `Preferences page shows "${await themeSelect.textContent()}" but the API says the current theme is ${JSON.stringify(originalTheme)} (${label(originalMode)})`,
      ).toContainText(label(originalMode));

      const patchPromise = page.waitForResponse(
        (res) => res.url().endsWith('/api/preferences') && res.request().method() === 'PATCH',
      );
      await themeSelect.click();
      await page.getByRole('option').filter({ hasText: label(nextMode) }).first().click();
      const patchRes = await patchPromise;
      expect(patchRes.status(), 'PATCH /api/preferences after changing the theme').toBe(200);
      expect((await patchRes.json()).theme, 'PATCH response does not reflect the new theme').toBe(nextTheme);

      // Ground truth from a fresh, independent request - not the mutation's
      // own response and not React Query's cache.
      const afterPatchRes = await page.request.get('/api/preferences');
      expect(
        (await afterPatchRes.json()).theme,
        'a fresh GET /api/preferences does not show the theme that was just set',
      ).toBe(nextTheme);

      // Persistence, not just in-memory state: reload the page fresh and
      // re-read what the server hands back on boot.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
      await expect(
        page.getByRole('combobox', { name: 'Theme' }),
        `theme reverted (or never persisted) after a fresh page load - expected "${label(nextMode)}"`,
      ).toContainText(label(nextMode));

      await testInfo.attach('preferences-after-reload.png', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    } finally {
      const restoreRes = await page.request.patch('/api/preferences', {
        data: { theme: originalTheme },
        headers: { 'X-Hub-Auth': '1' },
      });
      expect(restoreRes.status(), `restoring the original theme preference (was ${JSON.stringify(originalTheme)})`).toBe(
        200,
      );
      expect((await restoreRes.json()).theme, 'restore PATCH did not roundtrip the original theme back').toBe(
        originalTheme,
      );
    }
  },
);

test('the notification inbox shows real fleet activity, and marking one notification read is a persisted state change', async ({
  page,
}, testInfo) => {
  const orgId = await currentOrgId(page);

  await page.goto('/');
  const bell = page.getByRole('button', { name: /Notifications/ });
  await expect(bell, 'notification bell never rendered').toBeVisible();

  const listResponsePromise = page.waitForResponse(
    (res) => res.url().includes(`/api/orgs/${orgId}/inbox`) && res.request().method() === 'GET',
  );
  await bell.click();
  const listResponse = await listResponsePromise;
  expect(listResponse.status(), 'GET .../inbox that populates the tray').toBe(200);
  const inbox: {
    notifications: Array<{ id: number; kind: string; read_at?: string }>;
    unread_count: number;
  } = await listResponse.json();

  const tray = page.locator('[data-notif-tray]');
  await expect(tray, 'notification tray never opened').toBeVisible();

  await testInfo.attach('notification-tray.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  if (inbox.notifications.length === 0) {
    // Honest empty state: this environment has produced no org events yet.
    // Don't invent content to exercise mark-read against.
    await expect(tray.getByText("You're all caught up")).toBeVisible();
    return;
  }

  // This stack's fleet (alerts.spec.ts / issues.spec.ts) genuinely produces
  // issue.opened/issue.resolved rows, so there is real content to assert
  // against, not a fixture.
  expect(inbox.unread_count, 'inbox has notifications but reports 0 unread').toBeGreaterThan(0);

  // Pick the first unread row, skipping cluster.reconnected: its deep link
  // (clusterDefaultPath) renders as a plain <a href="/c/..."> per
  // NotificationTray.tsx, which is a full top-level navigation - clicking it
  // can abort the in-flight mark-read fetch before it lands. Every other
  // kind here renders as an in-tree <Link>, so the click and the fetch both
  // complete without a page swap racing them.
  const targetIndex = inbox.notifications.findIndex((n) => !n.read_at && n.kind !== 'cluster.reconnected');
  expect(targetIndex, 'no eligible unread notification found even though unread_count > 0').toBeGreaterThanOrEqual(0);
  const target = inbox.notifications[targetIndex];

  const row = tray.getByRole('menuitem').nth(targetIndex);
  await expect(row, `tray row ${targetIndex} for notification ${target.id} never rendered`).toBeVisible();

  const markReadPromise = page.waitForResponse(
    (res) => res.url().endsWith(`/inbox/${target.id}/read`) && res.request().method() === 'POST',
  );
  await row.click();
  const markReadRes = await markReadPromise;
  expect(markReadRes.status(), `marking notification ${target.id} read`).toBe(204);

  // Ground truth from a fresh request, independent of the tray's optimistic
  // cache update - proves the hub itself recorded the read, not just the
  // client's local state.
  const verifyRes = await page.request.get(`/api/orgs/${orgId}/inbox`);
  expect(verifyRes.status()).toBe(200);
  const verify: { notifications: Array<{ id: number; read_at?: string }> } = await verifyRes.json();
  const verified = verify.notifications.find((n) => n.id === target.id);
  expect(verified, `notification ${target.id} disappeared from the inbox after being marked read`).toBeTruthy();
  expect(verified!.read_at, `notification ${target.id} was clicked but the hub never recorded read_at`).toBeTruthy();
});
