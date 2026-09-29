import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { authStatePath, captureSurface } from './helpers';

// The cluster-onboarding flow an actual customer walks - as opposed to every
// other spec in this suite, which connects its cluster by calling the API
// directly and running `helm install` itself (convenient for setup, but not
// what a customer does). Two surfaces:
//
//  1. The in-app "Connect a cluster" wizard (/install): mints a real cluster
//     token via POST /api/clusters and hands the operator a Helm command that
//     bakes in the address the cluster dials + the token. This hub's public
//     URL is localhost, which no agent can dial, so the wizard asks where the
//     cluster runs; the e2e cluster is the hub's own, so the address is the
//     hub's in-cluster one. This is the "cloud-first wizard" path
//     (radar-hub/docs/OSS-TO-CLOUD-UX.md §5).
//
//  2. The Cloud Connect device flow (`radar cloud install --hub-url ...`,
//     radar-hub/docs/OSS-TO-CLOUD-UX.md §3): the CLI POSTs
//     /api/connect/requests, a human approves /connect/{id}, and the CLI polls
//     for the token. This stack's hub has only a localhost public URL, so it
//     has no address to hand the CLI's agent and refuses the request up
//     front; the spec checks that refusal and the unknown-id paths. The
//     approval leg needs a hub with an address agents can reach, which this
//     stack does not run.
//
// Deliberately NOT covered: actually installing a second radar agent
// (tests/multi-cluster.spec.ts already proves a second agent can connect, and
// two specs racing to mint cluster records on a shared, license-capped stack
// is asking for trouble). Both scenarios below stop the moment the hub has
// done its job - minted a real, verifiable credential - without ever running
// helm against this Kubernetes cluster.

const hubUrl = process.env.HUB_URL ?? 'http://localhost:18080';
// The hub's in-cluster address, the one run.sh installs radar with: the web
// Service's self-signed https port by in-cluster DNS name.
const HUB_NS = process.env.NS ?? 'radar-hub';
const expectedInClusterAgentURL = `wss://radar-hub-web.${HUB_NS}.svc.cluster.local/agent`;

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
// The value after `flag` in a shell command, with the single quotes the
// wizard puts around each value removed.
function flagValue(command: string, flag: string): string | undefined {
  const at = command.indexOf(flag);
  if (at < 0) return undefined;
  const raw = command.slice(at + flag.length).match(/^'([^']*)'|^(\S+)/);
  return raw ? (raw[1] ?? raw[2]) : undefined;
}

async function readHelmCommand(page: Page): Promise<string> {
  await page.getByRole('tab', { name: 'Helm CLI' }).click();
  const pre = page.getByRole('tabpanel').locator('pre');
  await expect(pre, 'no command block rendered in the Helm CLI tab').toBeVisible();
  return (await pre.textContent()) ?? '';
}

test('the install wizard names the hub\'s in-cluster address for a cluster next to it and mints a token the hub itself recognizes', async ({
  page,
}, testInfo) => {
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: 'Connect a cluster' })).toBeVisible();

  const clusterName = `e2e-onboarding-wizard-${Date.now()}`;
  await page.getByLabel('Cluster name').fill(clusterName);
  await page.getByRole('radio', { name: 'In the same cluster as the hub' }).click();
  await page.getByRole('button', { name: 'Generate install command' }).click();

  await expect(page.getByRole('heading', { name: 'Install in your cluster' })).toBeVisible();

  // The wizard writes ?cluster=<id> into the URL the moment POST /api/clusters
  // succeeds (Install.tsx's writeResumeParam) - the one place the real id is
  // legible without re-deriving it from the command text.
  const clusterId = new URL(page.url()).searchParams.get('cluster');
  expect(clusterId, 'wizard never wrote ?cluster=<id> after creating the cluster').toBeTruthy();
  trackedClusterIds.push(clusterId!);

  const command = await readHelmCommand(page);
  const cloudUrl = flagValue(command, '--set cloud.url=');
  const clusterNameFlag = flagValue(command, '--set cloud.clusterName=');
  const token = flagValue(command, '--from-literal=token=');

  expect(cloudUrl, 'command has no --set cloud.url= flag at all').toBeTruthy();
  expect(clusterNameFlag, 'command has no --set cloud.clusterName= flag at all').toBeTruthy();
  expect(token, 'command has no --from-literal=token= at all').toBeTruthy();

  // The in-cluster address, not the localhost public URL (which the agent
  // pod would resolve to itself), not a placeholder, not some other hub.
  expect(cloudUrl, `command points at "${cloudUrl}", not this hub's in-cluster address ${expectedInClusterAgentURL}`).toBe(
    expectedInClusterAgentURL,
  );
  // That listener's certificate is self-signed, so the agent must skip
  // verification or it never connects.
  expect(command, 'command lacks --set cloud.insecureSkipVerify=true for the self-signed in-cluster listener').toContain(
    '--set cloud.insecureSkipVerify=true',
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

  await captureSurface(page, testInfo, 'install-wizard-helm-cmd');
});

test('a hub whose only address is localhost refuses Cloud Connect and says where to connect instead', async ({
  page,
}) => {
  // Same request shape internal/cloud/connect.go's ConnectMetadata sends.
  // The refusal comes before any request is minted: an agent in the cluster
  // would resolve the hub's localhost URL to its own pod, and the hub has no
  // other address it could put in the CLI's install.
  const createRes = await page.request.post('/api/connect/requests', {
    data: {
      deployment_mode: 'in-cluster',
      cluster_name: `e2e-onboarding-connect-${Date.now()}`,
      radar_version: '9.9.9-e2e',
      k8s_version: '1.31.0',
      k8s_distro: 'kind',
      node_count: 1,
      scope: 'cluster-wide',
    },
  });
  expect(createRes.status(), 'POST /api/connect/requests on a hub with only a localhost address').toBe(409);
  // The CLI prints this body, so it has to point somewhere that works.
  expect(await createRes.text()).toContain("Connect clusters from the hub's Connect page");

  // Nothing was minted: the hub's cluster list has no cluster by that name.
  const clustersRes = await page.request.get('/api/clusters');
  expect(clustersRes.status()).toBe(200);
  const clusters = (await clustersRes.json()) as Array<{ name: string }>;
  expect(clusters.some((c) => c.name.startsWith('e2e-onboarding-connect-')), 'a refused connect request created a cluster').toBe(false);
});

test('an unknown connect id is rejected, not silently accepted', async ({ page }) => {
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
});
