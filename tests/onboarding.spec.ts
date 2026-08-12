import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { authStatePath } from './helpers';

// The cluster-onboarding flow an actual customer walks - as opposed to every
// other spec in this suite, which connects its cluster by calling the API
// directly and running `helm install` itself (convenient for setup, but not
// what a customer does). Two surfaces:
//
//  1. The in-app "Connect a cluster" wizard (/install): mints a real cluster
//     token via POST /api/clusters and hands the operator a Helm command that
//     bakes in this hub's real agent URL + the token. This is the
//     "cloud-first wizard" path (radar-hub/docs/OSS-TO-CLOUD-UX.md §5).
//
//  2. The Cloud Connect device flow (`radar cloud install --hub-url ...`,
//     radar-hub/docs/OSS-TO-CLOUD-UX.md §3): the CLI POSTs
//     /api/connect/requests, opens /connect/{id} in a browser for a human to
//     approve, then polls with its device_secret until the hub hands back the
//     minted token. This spec drives the create + poll legs exactly as
//     internal/cloud/connect.go does (verified against that file) and drives
//     the /connect/{id} approval itself through the real browser page - the
//     only thing simulated is the CLI process; a human still clicked Approve.
//
// Deliberately NOT covered: actually installing a second radar agent
// (tests/multi-cluster.spec.ts already proves a second agent can connect, and
// two specs racing to mint cluster records on a shared, license-capped stack
// is asking for trouble). Both scenarios below stop the moment the hub has
// done its job - minted a real, verifiable credential - without ever running
// helm against this Kubernetes cluster.

const hubUrl = process.env.HUB_URL ?? 'http://localhost:18080';
// Same derivation radar-hub's agentWSURL() applies to RADAR_HUB_PUBLIC_URL,
// and the same one the wizard's getAgentWsUrl() applies client-side to
// whatever origin the browser is on - independently reproduced here so the
// test has its own ground truth rather than trusting either code path.
const expectedAgentWSSURL = `${hubUrl.replace(/^http/, 'ws')}/agent`;

// Cloud Connect request ids are randURLSafe(16) - 22 base64url chars
// (auth/connectResume.ts's CONNECT_REQUEST_ID_PATTERN on the frontend,
// db.CreateConnectRequest on the hub). Anything of that shape that was never
// minted 404s cleanly; anything off-shape is rejected client-side before it
// even reaches the API. Use an all-digit stand-in - well-formed, but not a
// value randURLSafe(16) will ever produce as a live collision.
const UNKNOWN_CONNECT_ID = '0'.repeat(22);

// Cluster records this spec creates, for afterAll cleanup. A leaked record
// counts against this hub's trial cap (3 clusters, one already connected) and
// would eventually break every other scenario on the shared stack.
const trackedClusterIds: string[] = [];

// Set by the approval test, read by the "already handled" negative test that
// re-approves the same request. Connect *requests* have no delete endpoint at
// all (create/poll/preview/approve is the entire surface - see
// connect_handlers.go) - an unapproved one simply self-expires on its 15
// minute TTL without ever creating a cluster or counting against the license
// cap, so there is nothing to clean up for those.
let approvedConnectRequestId = '';

test.afterAll(async () => {
  if (trackedClusterIds.length === 0) return;
  const api = await playwrightRequest.newContext({ baseURL: hubUrl, storageState: authStatePath });
  for (const id of trackedClusterIds) {
    try {
      await api.delete(`/api/clusters/${id}`, { headers: { 'X-Hub-Auth': '1' } });
    } catch {
      // best effort - never mask a real failure with a cleanup error
    }
  }
  await api.dispose();
});

// Reads the command out of the wizard's rendered <pre> block. Selecting the
// Helm tab explicitly (rather than trusting whatever tab is active by
// default) keeps this robust to another agent on the shared stack having left
// a different tab preference in localStorage.
async function readHelmCommand(page: Page): Promise<string> {
  await page.getByRole('tab', { name: 'Helm CLI' }).click();
  const pre = page.getByRole('tabpanel').locator('pre');
  await expect(pre, 'no command block rendered in the Helm CLI tab').toBeVisible();
  return (await pre.textContent()) ?? '';
}

test('the install wizard names this hub\'s real agent URL and mints a token the hub itself recognizes', async ({
  page,
}, testInfo) => {
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: 'Connect a cluster' })).toBeVisible();

  const clusterName = `e2e-onboarding-wizard-${Date.now()}`;
  await page.getByLabel('Cluster name').fill(clusterName);
  await page.getByRole('button', { name: 'Generate install command' }).click();

  await expect(page.getByRole('heading', { name: 'Install in your cluster' })).toBeVisible();

  // The wizard writes ?cluster=<id> into the URL the moment POST /api/clusters
  // succeeds (Install.tsx's writeResumeParam) - the one place the real id is
  // legible without re-deriving it from the command text.
  const clusterId = new URL(page.url()).searchParams.get('cluster');
  expect(clusterId, 'wizard never wrote ?cluster=<id> after creating the cluster').toBeTruthy();
  trackedClusterIds.push(clusterId!);

  const command = await readHelmCommand(page);
  const cloudUrl = command.match(/--set cloud\.url=(\S+)/)?.[1];
  const clusterNameFlag = command.match(/--set cloud\.clusterName=(\S+)/)?.[1];
  const token = command.match(/--from-literal=token=(\S+)/)?.[1];

  expect(cloudUrl, 'command has no --set cloud.url= flag at all').toBeTruthy();
  expect(clusterNameFlag, 'command has no --set cloud.clusterName= flag at all').toBeTruthy();
  expect(token, 'command has no --from-literal=token= at all').toBeTruthy();

  // "Names this hub's real public URL" - not a placeholder, not some other
  // hub. Checked two ways: against our own independent derivation from
  // HUB_URL, and (in the next test) against what the create-connect-request
  // endpoint itself reports for this same deployment.
  expect(cloudUrl, `command points at "${cloudUrl}", not this hub's agent URL ${expectedAgentWSSURL}`).toBe(
    expectedAgentWSSURL,
  );
  expect(clusterNameFlag, 'cloud.clusterName does not match the cluster id the wizard just created').toBe(
    clusterId,
  );

  // "Carries a real, freshly-minted cluster token" - proven by asking the hub
  // to authenticate with it, not by eyeballing the rhc_ prefix. GET
  // /api/agent/status is bearer-only (internal/server/agent_status.go): it
  // looks the raw token up by its SHA-256 hash and returns the cluster it
  // resolves to. A placeholder or stale token 401s here.
  const statusRes = await page.request.get('/api/agent/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(statusRes.status(), 'the token the wizard printed was rejected by the hub\'s own agent-status endpoint - it is not a real credential').toBe(200);
  const status = await statusRes.json();
  expect(status.cluster_id, 'the token resolves to a different cluster than the one the wizard just created').toBe(
    clusterId,
  );
  // never_connected, not connected: this spec never runs helm, so the tunnel
  // genuinely never attached. Anything other than never_connected/disconnected
  // here would mean the token secretly belongs to some other, already-live
  // cluster - the opposite of "freshly minted".
  expect(['never_connected', 'disconnected']).toContain(status.status);

  await testInfo.attach('install-wizard.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('the /connect/:id page drives a real Cloud Connect request through approval, exactly what the CLI needs', async ({
  page,
}, testInfo) => {
  // Same request shape internal/cloud/connect.go's ConnectMetadata sends -
  // deployment_mode is the only field the hub requires, the rest is
  // display-only consent-card metadata, but sending real-shaped values keeps
  // this test honest about what a real `radar cloud install` invocation looks
  // like rather than an API-shaped stub.
  const clusterName = `e2e-onboarding-connect-${Date.now()}`;
  const createRes = await page.request.post('/api/connect/requests', {
    data: {
      deployment_mode: 'in-cluster',
      cluster_name: clusterName,
      radar_version: '9.9.9-e2e',
      k8s_version: '1.31.0',
      k8s_distro: 'kind',
      node_count: 1,
      scope: 'cluster-wide',
    },
  });
  expect(createRes.status(), 'POST /api/connect/requests (public, no hub identity yet - what the CLI calls first)').toBe(
    201,
  );
  const created = await createRes.json();
  for (const field of ['request_id', 'device_secret', 'connect_url', 'wss_url', 'expires_in', 'poll_interval']) {
    expect(created[field], `create-connect-request response is missing "${field}" - the CLI cannot proceed without it`).toBeTruthy();
  }
  approvedConnectRequestId = created.request_id;

  // The URL the CLI would print and open in a browser must actually point at
  // this hub's own /connect/{id} page - not a doc example, not another stack.
  expect(created.connect_url).toBe(`${hubUrl}/connect/${created.request_id}`);
  // Same agent URL the install wizard bakes in - this is the URL Radar dials
  // once it has the token, and it must agree across both onboarding paths.
  expect(created.wss_url).toBe(expectedAgentWSSURL);

  // The CLI's own poll leg (internal/cloud/connect.go's Poll, Authorization:
  // Bearer <device_secret>) before anyone has approved anything - proves the
  // poll channel is live and reports "pending" honestly, the same call
  // PollUntilApproved makes in a loop.
  const prePoll = await page.request.get(`/api/connect/requests/${created.request_id}`, {
    headers: { Authorization: `Bearer ${created.device_secret}` },
  });
  expect(prePoll.status(), 'device-secret poll of a freshly created, unapproved request').toBe(200);
  expect((await prePoll.json()).status).toBe('pending');

  // Now the human leg: open the same URL the CLI printed, signed in as the
  // admin, and approve it - the actual browser page, not a simulated POST.
  await page.goto(`/connect/${created.request_id}`);
  await expect(page.getByRole('heading', { name: /Connect this cluster to/ })).toBeVisible();
  // The consent card is the anti-phishing surface (OSS-TO-CLOUD-UX.md §3) -
  // it must name the cluster metadata this specific request carries, not a
  // generic "approve?" prompt.
  await expect(page.getByText(clusterName, { exact: false })).toBeVisible();
  await expect(page.getByText('Kubernetes 1.31.0', { exact: false })).toBeVisible();

  await testInfo.attach('connect-consent-card.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  const approveResponsePromise = page.waitForResponse(
    (res) => res.url().includes(`/api/connect/requests/${created.request_id}/approve`) && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Connect cluster' }).click();
  const approveResponse = await approveResponsePromise;
  expect(approveResponse.status(), 'approving the connect request as the signed-in admin').toBe(200);
  const approvedClusterId = (await approveResponse.json()).cluster_id as string;
  expect(approvedClusterId, 'approve response carries no cluster_id').toBeTruthy();
  trackedClusterIds.push(approvedClusterId);

  // The page itself must reflect the approved state, not just the network
  // call underneath it - WaitingForCluster replaces the consent form the
  // moment approval succeeds.
  await expect(
    page.getByRole('heading', { name: /Connecting your cluster|Approved.*connecting/i }),
  ).toBeVisible();

  // "Yields what the CLI needs": re-poll the SAME device-secret channel the
  // CLI is blocked on (PollUntilApproved's loop). Per internal/cloud/connect.go,
  // an approved response missing cluster_id, token, or wss_url is treated as
  // "hub approved the connection but returned incomplete details" - a real
  // error path in the CLI - so this is the actual bar, not a looser one.
  const postPoll = await page.request.get(`/api/connect/requests/${created.request_id}`, {
    headers: { Authorization: `Bearer ${created.device_secret}` },
  });
  expect(postPoll.status()).toBe(200);
  const polled = await postPoll.json();
  expect(polled.status, 'the connect request never reached "approved" on the CLI\'s own poll channel').toBe(
    'approved',
  );
  expect(polled.cluster_id).toBe(approvedClusterId);
  expect(polled.token, 'approved poll response carries no token - the CLI would report incomplete details and refuse to proceed').toMatch(/^rhc_/);
  expect(polled.wss_url).toBe(expectedAgentWSSURL);

  // Ground truth from the hub's own cluster list, independent of anything the
  // connect flow told us about itself.
  const clustersRes = await page.request.get('/api/clusters');
  expect(clustersRes.status()).toBe(200);
  const clusters = (await clustersRes.json()) as Array<{ id: string; status: string }>;
  const approved = clusters.find((c) => c.id === approvedClusterId);
  expect(approved, `approved cluster ${approvedClusterId} does not appear in GET /api/clusters at all`).toBeTruthy();
  expect(['never_connected', 'disconnected']).toContain(approved!.status);
});

test('an unknown or already-approved connect id is rejected, not silently accepted', async ({ page }) => {
  test.skip(!approvedConnectRequestId, 'depends on the approval test above having run first');

  // Unknown id: well-formed (passes the frontend's own id-shape check), never
  // minted. Both the public preview and the session-authed approve must 404 -
  // not silently hand back some other request's data.
  const previewRes = await page.request.get(`/api/connect/requests/${UNKNOWN_CONNECT_ID}/preview`);
  expect(previewRes.status(), 'preview of a connect id that was never created').toBe(404);

  const approveUnknownRes = await page.request.post(`/api/connect/requests/${UNKNOWN_CONNECT_ID}/approve`, {
    headers: { 'X-Hub-Auth': '1' },
    data: {},
  });
  expect(approveUnknownRes.status(), 'approving a connect id that was never created').toBe(404);

  // Same id, rendered in the real browser page: the operator sees an honest
  // "not found", not a blank screen or a stuck spinner.
  await page.goto(`/connect/${UNKNOWN_CONNECT_ID}`);
  await expect(
    page.getByRole('heading', { name: /Connect link not found|Invalid connect link/ }),
  ).toBeVisible();

  // Already-approved: re-approve the SAME request the previous test just
  // consumed. The row is no longer "pending" (db.ErrConnectNotPending), so
  // this must be a real conflict - never a second cluster minted from the
  // same request.
  const reapproveRes = await page.request.post(`/api/connect/requests/${approvedConnectRequestId}/approve`, {
    headers: { 'X-Hub-Auth': '1' },
    data: {},
  });
  expect(
    reapproveRes.status(),
    'approving a connect request a second time must conflict, not mint a second cluster',
  ).toBe(409);
});
