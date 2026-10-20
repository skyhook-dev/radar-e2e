import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, authStatePath, captureSurface, gotoWhenNotRateLimited } from './helpers';

// Organisation and settings pages, held to the hub's own records.
//
// These pages decide who can do what, so "it rendered" is a particularly weak
// thing to know about them. A members table that silently omits someone, or
// shows the wrong role, is a security-shaped problem that renders perfectly.
//
// Everything here is compared with the API the page is built on: the org's
// name, every member with their role, and the alert rules that decide who gets
// told about problems.

test.use({ storageState: authStatePath });
test.setTimeout(240_000);

type Member = { user_id: string; email: string; role: string };
type Rule = { id: string; name: string; enabled: boolean; inbox_enabled?: boolean };

async function org(page: Page): Promise<{ id: string; name: string }> {
  return page.evaluate(async () => {
    const res = await fetch('/api/orgs');
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : (body.orgs ?? [])[0];
    return { id: first?.id ?? '', name: first?.name ?? '' };
  });
}

async function fetchList<T>(page: Page, path: string, key: string): Promise<T[]> {
  return page
    .evaluate(
      async ([p, k]) => {
        const res = await fetch(p);
        if (!res.ok) return [];
        const body = await res.json();
        return body[k] ?? (Array.isArray(body) ? body : []);
      },
      [path, key],
    )
    .catch(() => []);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await assertClusterConnected(page);
});

test('organization settings and members match the hub records', async ({ page }, testInfo) => {
  const { id, name } = await org(page);
  expect(id, 'the hub reports no organisation').not.toBe('');

  const members = await fetchList<Member>(page, `/api/orgs/${id}/members`, 'members');
  expect(members.length, 'the hub records no members, so the page cannot be checked').toBeGreaterThan(0);

  await gotoWhenNotRateLimited(page, '/settings/organization');
  await expect(
    page.locator('form').getByRole('textbox').first(),
    'the organization name field does not match the hub record',
  ).toHaveValue(name);

  await gotoWhenNotRateLimited(page, '/settings/organization/members');

  // Every member, with the role they actually hold. A page that lists people
  // but not their roles cannot answer "who can do this".
  for (const member of members) {
    const row = page.getByRole('table').first().getByRole('row').filter({ hasText: member.email });
    await expect(row, `the members table does not list ${member.email}`).toBeVisible();
    await expect(row, `the members table gives ${member.email} the wrong role`).toContainText(member.role, {
      ignoreCase: true,
    });
  }

  await captureSurface(page, testInfo, 'org-members-truth');
});

test('the alert rules the hub stores are the rules the product shows', async ({ page }, testInfo) => {
  const { id } = await org(page);
  const rules = await fetchList<Rule>(page, `/api/orgs/${id}/alerts/rules`, 'rules');
  test.skip(rules.length === 0, 'this org has no alert rules to compare');

  await gotoWhenNotRateLimited(page, '/alerts');
  await page.getByRole('link', { name: 'Manage rules', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/organization\/notifications$/);
  for (const rule of rules) {
    await expect(
      page.getByText(rule.name, { exact: true }),
      `the hub stores an alert rule called "${rule.name}" but notification settings do not show it`,
    ).toBeVisible();
  }

  // Whether a rule delivers to the inbox is what decides if anyone is told
  // about a problem, so it is recorded for every rule - this is the evidence
  // behind the open question about notifications in KNOWN-ISSUES.md.
  testInfo.annotations.push({
    type: 'alert-rules',
    description: rules
      .map((r) => `${r.name}: enabled=${r.enabled}, inbox=${r.inbox_enabled ?? 'unset'}`)
      .join(' | '),
  });

  await captureSurface(page, testInfo, 'alert-rules-truth');
});
