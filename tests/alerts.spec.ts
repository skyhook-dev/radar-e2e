import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl, captureSurface } from './helpers';

// Alerting end-to-end. The chain under test is:
//
//   an owner defines an alert rule -> the alert worker (radar-hub's
//   alerts_worker.go) polls the cluster's /api/issues over the tunnel on a
//   fixed cadence -> a match opens a durable alert_instances row -> the row
//   surfaces in GET /api/orgs/{id}/alerts/instances and on the /alerts page.
//
// Cadence, read from the source (not assumed): cmd/hub/main.go defaults
// HUB_ALERTS_POLL_INTERVAL to 60s and HUB_ALERTS_JITTER to +/-15s; the
// deployment here sets neither. alerts_worker.go's run() ticks a shared
// claim loop every min(max(poll_interval/6, 5s), 15s) = 10s and polls
// whichever (org, cluster) cursors are due.
//
// A NEW rule's first poll of a cluster is a baseline poll: whatever already
// matches seeds silently (alerts.NextOnSeen, Seeded=true) and never
// notifies, by design, so enabling a rule doesn't burst-notify on every
// pre-existing problem. Proving a genuine "fire" (Seeded=false) requires the
// broken workload to not exist yet when that first poll runs - but this
// stack seeds every org with a default "critical issues" rule at bootstrap
// (db.insertDefaultCriticalAlertRule), so this cluster's alert cursor is
// already on a live, continuously-cycling schedule by the time any test
// runs. handleCreateAlertRule's ensureAlertCursorsForOrg only resets
// next_poll_at to now when a cursor is PARKED (EnsureClusterCursors' ON
// CONFLICT guards on the parked sentinel) - an already-cycling cursor just
// keeps its existing, unpredictable-from-here schedule. So a fixed sleep
// cannot reliably land before that first poll.
//
// Test 2 sidesteps the guess: it creates a throwaway decoy workload
// alongside the rule and waits for ANY alert instance referencing the
// decoy. Baseline is a one-time flag per (rule, cluster) recorded before
// the poll returns, so the decoy's mere appearance - baseline-seeded or
// not - proves the (rule, cluster) baseline has completed. Only then does
// it create the real test workload, so the real workload's resulting
// instance is guaranteed to go through the non-baseline path and its
// seeded=false is real evidence of a genuine fire, not a guess.
//
// This suite verifies what an operator would notice immediately if
// alerting broke: a rule can be created and persists (1), a rule watching a
// real live condition actually fires and is visible as an alert (2), and a
// rule's configuration - the thing an owner set up - is rendered back
// accurately in the UI (3).

const NAMESPACE = 'e2e-alerts';

async function currentOrgId(page: Page): Promise<string> {
  const res = await page.request.get('/api/account');
  expect(res.status(), 'account endpoint').toBe(200);
  const account = await res.json();
  expect(account.current_org_id, 'signed-in admin has no current_org_id').toBeTruthy();
  return account.current_org_id as string;
}

type AlertRuleFilters = {
  cluster_ids?: string[];
  namespaces?: string[];
  severities?: string[];
};

type CreateAlertRuleRequest = {
  name: string;
  filters?: AlertRuleFilters;
  inbox_enabled?: boolean;
  notify_on_resolve?: boolean;
};

type AlertRule = {
  id: string;
  name: string;
  filters: AlertRuleFilters;
  inbox_enabled: boolean;
  notify_on_resolve: boolean;
};

type AlertInstance = {
  id: number;
  rule_id: string;
  status: string;
  seeded: boolean;
  current_issue?: { name?: string; namespace?: string };
};

async function createRule(page: Page, orgId: string, body: CreateAlertRuleRequest): Promise<AlertRule> {
  const res = await page.request.post(`/api/orgs/${orgId}/alerts/rules`, {
    headers: { 'X-Hub-Auth': '1' },
    data: body,
  });
  expect(res.status(), `creating alert rule "${body.name}": ${await res.text()}`).toBe(201);
  return res.json();
}

async function deleteRule(page: Page, orgId: string, ruleId: string) {
  // Best-effort: cleanup must not mask a test failure, and other agents
  // share this org, so a leftover test rule is worth removing even if the
  // test itself failed.
  await page.request
    .delete(`/api/orgs/${orgId}/alerts/rules/${ruleId}`, { headers: { 'X-Hub-Auth': '1' } })
    .catch(() => {});
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
  const existing = kubectl(
    'get',
    'namespace',
    NAMESPACE,
    '--ignore-not-found',
    '-o',
    'jsonpath={.metadata.name}',
  );
  if (existing !== NAMESPACE) kubectl('create', 'namespace', NAMESPACE);
});

test('an alert rule can be created through the UI, appears in the rules list, and survives a page load', async ({
  page,
}, testInfo) => {
  const orgId = await currentOrgId(page);
  const ruleName = `E2E create rule ${Date.now()}`;

  await page.goto('/settings/organization/notifications');
  await expect(page.getByRole('heading', { name: 'Issue notifications', level: 2 })).toBeVisible();

  // The section shows "Add rule" once any rule exists (every org ships a
  // default critical-issues rule) or "Custom rule" on a genuinely empty
  // list - either opens the same dialog.
  const openDialog = page.getByRole('button', { name: /^(Add rule|Custom rule)$/ });
  await expect(openDialog.first(), 'no control to open the new-rule dialog').toBeVisible();
  await openDialog.first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog, 'rule dialog never opened').toBeVisible();

  await dialog.getByPlaceholder('Notify on critical issues').fill(ruleName);
  // Scope to our own namespace so this rule can never fire on another
  // agent's workload elsewhere in the shared cluster.
  await dialog
    .locator('label', { hasText: 'Namespaces' })
    .locator('xpath=following-sibling::input')
    .fill(NAMESPACE);

  await dialog.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByRole('dialog'), 'rule dialog stayed open after Create rule').toHaveCount(0);

  let ruleId: string | undefined;
  try {
    const row = page.getByRole('listitem').filter({ hasText: ruleName });
    await expect(row.first(), `"${ruleName}" never appeared in the rules list after creating it`).toBeVisible();

    ruleId = (await row.first().locator('span.font-mono').first().textContent())?.trim();
    expect(ruleId, 'could not read the created rule id off its row').toBeTruthy();

    // Ground truth: the row must correspond to a real server-side rule, not
    // just optimistic UI state.
    const res = await page.request.get(`/api/orgs/${orgId}/alerts/rules`);
    expect(res.status(), 'alert rules endpoint').toBe(200);
    const rules = (await res.json()).rules as AlertRule[];
    const apiRule = rules.find((r) => r.id === ruleId);
    expect(apiRule, `rule ${ruleId} shown in the UI is missing from GET .../alerts/rules`).toBeTruthy();
    expect(apiRule?.name).toBe(ruleName);

    // Survives a page load: a full navigation (not a reload inside a poll
    // loop), then the row must still be there without any client-side help.
    await page.goto('/settings/organization/notifications');
    await expect(
      page.getByRole('listitem').filter({ hasText: ruleName }).first(),
      `"${ruleName}" did not survive a page load`,
    ).toBeVisible();

    await captureSurface(page, testInfo, 'alert-rules-list-persisted');
  } finally {
    if (ruleId) await deleteRule(page, orgId, ruleId);
  }
});

// Poll the instances endpoint for a rule/workload-name match. Returns the
// instance once found, or null on timeout. A 429 is treated as "keep
// waiting", per the shared /api/fleet/* rate limit note - this endpoint
// isn't under /api/fleet/*, but the same courtesy costs nothing here.
async function waitForInstance(
  page: Page,
  orgId: string,
  ruleId: string,
  workloadName: string,
  timeout: number,
): Promise<AlertInstance | null> {
  let found: AlertInstance | null = null;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/orgs/${orgId}/alerts/instances?status=open&cluster_id=${clusterId}`,
        );
        if (res.status() !== 200) return false; // 429 or transient - keep polling
        const instances = (await res.json()).instances as AlertInstance[];
        found = instances.find((i) => i.rule_id === ruleId && i.current_issue?.name === workloadName) ?? null;
        return found !== null;
      },
      { timeout, intervals: [3000, 5000, 8000] },
    )
    .toBe(true)
    .catch(() => {
      // Turned into a descriptive assertion failure by the caller, which
      // has the workload/rule context to say something useful.
    });
  return found;
}

test('a rule matching a real, live ErrImagePull condition actually fires and appears as an alert instance', async ({
  page,
}, testInfo) => {
  test.setTimeout(260_000);
  const orgId = await currentOrgId(page);

  await page.goto('/');
  await assertClusterConnected(page);

  const ruleName = `E2E fire rule ${Date.now()}`;
  const rule = await createRule(page, orgId, {
    name: ruleName,
    filters: { cluster_ids: [clusterId], namespaces: [NAMESPACE], severities: ['critical'] },
    inbox_enabled: true,
    notify_on_resolve: true,
  });

  const decoy = `alert-baseline-decoy-${Date.now()}`;
  const workload = `alert-probe-${Date.now()}`;
  try {
    // Step 1: force this (rule, cluster) pair's baseline poll to happen and
    // become observable, using a throwaway broken workload as the probe.
    // See the file header for why a fixed sleep can't be trusted here.
    kubectl(
      '-n',
      NAMESPACE,
      'create',
      'deployment',
      decoy,
      '--image=registry.invalid.example/nope:v1',
      '--replicas=1',
    );
    const decoyInstance = await waitForInstance(page, orgId, rule.id, decoy, 110_000);
    expect(
      decoyInstance,
      `baseline probe never fired: no alert instance for rule ${rule.id} / decoy workload ${decoy} within the budget - the alert worker never polled this cluster for the new rule`,
    ).toBeTruthy();

    // Step 2: baseline is now guaranteed complete for (rule, cluster) -
    // whatever the decoy's own seeded value was, MarkBaselined already ran
    // before that poll returned. A NEW workload from here on must go
    // through the genuine open path.
    kubectl('-n', NAMESPACE, 'delete', 'deployment', decoy, '--ignore-not-found', '--wait=false');
    kubectl(
      '-n',
      NAMESPACE,
      'create',
      'deployment',
      workload,
      '--image=registry.invalid.example/nope:v1',
      '--replicas=1',
    );

    // ErrImagePull is classified severity=critical by radar (verified live
    // against this stack, not assumed from a unit-test fixture), so it
    // matches this rule's severity filter as soon as radar's own detector
    // sees it (seconds) and the worker's next poll evaluates it (up to a
    // full poll interval away - see file header).
    const instance = await waitForInstance(page, orgId, rule.id, workload, 110_000);
    expect(
      instance,
      `no open alert instance for rule ${rule.id} / workload ${workload} - the alert worker never fired on a live ErrImagePull condition`,
    ).toBeTruthy();
    expect(
      instance!.seeded,
      `alert instance for ${workload} is seeded=true even though it was created after baseline completed - it should have opened as a genuine fire`,
    ).toBe(false);
    expect(instance!.current_issue?.namespace).toBe(NAMESPACE);

    // And it is visible where an operator actually looks.
    await page.goto('/alerts');
    await expect
      .poll(() => page.getByText(workload).count(), {
        message: `/alerts page never showed an entry for ${workload}`,
        timeout: 20_000,
        intervals: [2000, 3000],
      })
      .toBeGreaterThan(0);

    await testInfo.attach('fired-alert-instance.json', {
      body: JSON.stringify(instance, null, 2),
      contentType: 'application/json',
    });
    await captureSurface(page, testInfo, 'alerts-list-fired');
  } finally {
    kubectl('-n', NAMESPACE, 'delete', 'deployment', decoy, '--ignore-not-found', '--wait=false');
    kubectl('-n', NAMESPACE, 'delete', 'deployment', workload, '--ignore-not-found', '--wait=false');
    await deleteRule(page, orgId, rule.id);
  }
});

test('the rules list and its edit dialog render exactly the rule configuration stored server-side', async ({
  page,
}, testInfo) => {
  const orgId = await currentOrgId(page);
  const ruleName = `E2E render rule ${Date.now()}`;

  const rule = await createRule(page, orgId, {
    name: ruleName,
    filters: { severities: ['critical', 'warning'], namespaces: [NAMESPACE] },
    inbox_enabled: true,
    notify_on_resolve: false,
  });

  try {
    await page.goto('/settings/organization/notifications');
    const row = page.getByRole('listitem').filter({ hasText: ruleName });
    await expect(row.first(), `rule "${ruleName}" never rendered in the list`).toBeVisible();

    // The list row is a summary of server state - each chip must match what
    // was actually POSTed, not a default.
    await expect(
      row.first(),
      'rules list does not show the configured severities (critical + warning)',
    ).toContainText('critical + warning');
    await expect(
      row.first(),
      `rules list does not show the configured namespace scope (ns: ${NAMESPACE})`,
    ).toContainText(`ns: ${NAMESPACE}`);
    await expect(row.first(), 'rules list does not show the inbox delivery channel').toContainText('Inbox');

    await row.first().getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog, 'edit dialog never opened').toBeVisible();

    await expect(
      dialog.getByRole('button', { name: 'Critical' }),
      'edit dialog does not show Critical as selected',
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      dialog.getByRole('button', { name: 'Warning' }),
      'edit dialog does not show Warning as selected',
    ).toHaveAttribute('aria-pressed', 'true');

    const namespacesInput = dialog
      .locator('label', { hasText: 'Namespaces' })
      .locator('xpath=following-sibling::input');
    await expect(namespacesInput, 'edit dialog does not show the configured namespace').toHaveValue(NAMESPACE);

    const inboxCheckbox = dialog.locator('label', { hasText: 'In-app inbox' }).locator('input[type="checkbox"]');
    await expect(inboxCheckbox, 'edit dialog does not show inbox delivery as checked').toBeChecked();

    const resolveToggle = dialog
      .locator('label', { hasText: 'Notify when issues resolve' })
      .locator('input[type="checkbox"]');
    await expect(
      resolveToggle,
      'edit dialog shows "Notify when issues resolve" checked, but the rule was created with notify_on_resolve=false',
    ).not.toBeChecked();

    // Element shot, not the page: a dialog photographed with all the chrome
    // around it buries the thing under review in noise.
    await captureSurface(page, testInfo, 'alert-rule-dialog-hydrated', dialog);

    // Close without saving - Escape is safe here (not mid-mutation).
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog'), 'edit dialog did not close on Escape').toHaveCount(0);
  } finally {
    await deleteRule(page, orgId, rule.id);
  }
});
