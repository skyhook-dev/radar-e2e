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

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

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

test('the organisation page shows the org and every member the hub records', async ({ page }, testInfo) => {
  const { id, name } = await org(page);
  expect(id, 'the hub reports no organisation').not.toBe('');

  const members = await fetchList<Member>(page, `/api/orgs/${id}/members`, 'members');
  expect(members.length, 'the hub records no members, so the page cannot be checked').toBeGreaterThan(0);

  await gotoWhenNotRateLimited(page, '/settings/organization');
  await expect
    .poll(async () => (await bodyText(page)).length, { timeout: 60_000, intervals: [1000, 2000, 3000] })
    .toBeGreaterThan(300);

  const text = await bodyText(page);
  expect.soft(text, `the organisation page does not name the org (${name})`).toContain(name);

  // Every member, with the role they actually hold. A page that lists people
  // but not their roles cannot answer "who can do this".
  for (const member of members) {
    expect
      .soft(text, `the hub records ${member.email} as a member but the page does not list them`)
      .toContain(member.email);
    expect
      .soft(
        text.toLowerCase(),
        `the page lists ${member.email} but not the role the hub gives them (${member.role})`,
      )
      .toContain(member.role.toLowerCase());
  }

  await captureSurface(page, testInfo, 'org-members-truth');
});

test('the alert rules the hub stores are the rules the product shows', async ({ page }, testInfo) => {
  const { id } = await org(page);
  const rules = await fetchList<Rule>(page, `/api/orgs/${id}/alerts/rules`, 'rules');
  test.skip(rules.length === 0, 'this org has no alert rules to compare');

  await gotoWhenNotRateLimited(page, '/alerts');
  await expect
    .poll(async () => (await bodyText(page)).length, { timeout: 60_000, intervals: [1000, 2000, 3000] })
    .toBeGreaterThan(300);

  const text = await bodyText(page);
  for (const rule of rules) {
    expect
      .soft(text, `the hub stores an alert rule called "${rule.name}" but the Alerts page does not show it`)
      .toContain(rule.name);
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
