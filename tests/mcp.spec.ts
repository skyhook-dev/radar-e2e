import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { clusterId, kubectl } from './helpers';

// MCP through the hub: this is the surface AI agents (Claude Desktop, Cursor,
// Claude Code) actually use to query a customer's cluster - a personal access
// token, JSON-RPC over the org-level /mcp aggregator, unwrapped from radar's
// SSE framing. Zero coverage before this file, despite being real
// paying-customer surface.
//
// The chain under test, per internal/mcp/ (radar-hub) + internal/mcp/tools.go
// (radar):
//
//   PAT (rhp_...) -> hub's /mcp org aggregator (internal/server/server.go
//   mounts s.mcpHandler behind s.mcpAuth) -> internal/mcp/bridge.go strips the
//   `cluster` arg and dispatches over the yamux tunnel to that cluster's radar
//   -> radar's own /mcp (internal/mcp/tools.go) answers from its live K8s
//   informer cache -> the hub unwraps radar's text/event-stream response
//   (dispatcher.go's parseRPCResponse/extractJSONFromSSE) and re-wraps it in
//   its OWN SSE framing back to us (the hub's /mcp is the same go-sdk
//   Streamable HTTP handler radar uses, so the client here has to unwrap SSE
//   too - see sseExtractJSON below).
//
// Tool choice: list_namespaces. It needs no fixture, has a small deterministic
// answer, and can be checked directly against `kubectl get namespaces` -
// proving the whole chain returns real cluster data, not just a 200.

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:18080';

// Radar's Streamable HTTP transport 400s unless the client sends exactly this
// Accept value (see radar-hub/CLAUDE.md "Known gotchas" and
// dispatcher.go:Dispatch). The hub's own /mcp is the same go-sdk transport,
// so the requirement applies to every request we send it too.
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

type JsonRpcEnvelope = {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string };
};

/**
 * Unwrap `event: message\ndata: <json>\n\n` framing. Mirrors
 * radar-hub/internal/mcp/dispatcher.go's extractJSONFromSSE, applied here to
 * the hub's OWN response to us rather than radar's response to the hub -
 * same go-sdk Streamable HTTP handler on both hops, same framing.
 */
function sseExtractJSON(body: string): string {
  const dataLines = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s?/, ''));
  return dataLines.length > 0 ? dataLines.join('') : body;
}

function parseRPC(raw: string): JsonRpcEnvelope {
  return JSON.parse(sseExtractJSON(raw));
}

/** Mint a PAT via the cookie-authenticated UI-adjacent API (settings.spec.ts drives the same endpoint through the UI). */
async function mintPAT(page: import('@playwright/test').Page, name: string): Promise<{ id: string; token: string }> {
  const res = await page.request.post('/api/pats', {
    headers: { 'X-Hub-Auth': '1' },
    data: { name },
  });
  expect(res.status(), 'minting a personal access token via POST /api/pats').toBe(201);
  const body = await res.json();
  expect(body.token, 'POST /api/pats did not return the raw token').toBeTruthy();
  expect(body.pat?.id, 'POST /api/pats did not return the token id').toBeTruthy();
  return { id: body.pat.id as string, token: body.token as string };
}

async function revokePAT(page: import('@playwright/test').Page, patId: string) {
  const res = await page.request.delete(`/api/pats/${patId}`, {
    headers: { 'X-Hub-Auth': '1' },
  });
  expect(res.status(), `revoking token ${patId}`).toBe(204);
}

test.describe('MCP over the hub', () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    // Explicitly empty storageState: the chromium project config sets
    // storageState: '.run/auth.json' (the shared admin session), and
    // request.newContext() inherits that project default when the option is
    // omitted - it is NOT a clean slate here by default. Every call in this
    // suite authenticates itself explicitly via the Authorization header
    // (or, for the negative tests, not at all), matching how a real MCP
    // client talks to the hub - it can't carry the browser's session
    // cookie. Leaking the admin's cookie jar in here would make BOTH the
    // unauthenticated-request assertions meaningless (auth.Middleware falls
    // back to the cookie when Authorization is absent) AND the positive-path
    // test dishonest (a broken PAT path that fell through to cookie auth
    // would still "pass").
    api = await playwrightRequest.newContext({ baseURL: HUB_URL, storageState: { cookies: [], origins: [] } });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('mints a PAT, speaks MCP through the hub, and list_namespaces matches kubectl', async ({ page }, testInfo) => {
    const tokenName = `e2e-mcp-${Date.now()}`;
    const { id: patId, token } = await mintPAT(page, tokenName);

    const authHeaders = { ...MCP_HEADERS, Authorization: `Bearer ${token}` };

    try {
      // --- initialize ---
      const initRes = await api.post('/mcp', {
        headers: authHeaders,
        data: {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'radar-hub-e2e', version: '0' },
          },
        },
      });
      expect(initRes.status(), 'mcp initialize with a freshly minted PAT').toBe(200);
      const sessionId = initRes.headers()['mcp-session-id'];
      expect(sessionId, 'initialize response is missing the Mcp-Session-Id header').toBeTruthy();
      const initBody = parseRPC(await initRes.text());
      expect(initBody.error, `initialize returned a JSON-RPC error: ${JSON.stringify(initBody.error)}`).toBeUndefined();
      expect(initBody.result?.capabilities?.tools, 'initialize result has no tools capability').toBeTruthy();

      const sessionHeaders = { ...authHeaders, 'Mcp-Session-Id': sessionId };

      // notifications/initialized is a JSON-RPC notification (no id) - the
      // SDK expects the client to send it before any other call on a fresh
      // session, and it carries no meaningful response body.
      const notifyRes = await api.post('/mcp', {
        headers: sessionHeaders,
        data: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(notifyRes.status(), 'notifications/initialized').toBeLessThan(300);

      // --- tools/list ---
      const listRes = await api.post('/mcp', {
        headers: sessionHeaders,
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
      expect(listRes.status(), 'mcp tools/list').toBe(200);
      const listBody = parseRPC(await listRes.text());
      expect(listBody.error, `tools/list returned a JSON-RPC error: ${JSON.stringify(listBody.error)}`).toBeUndefined();
      const tools = (listBody.result?.tools ?? []) as Array<{ name: string }>;
      expect(
        tools.some((t) => t.name === 'list_namespaces'),
        `list_namespaces missing from tools/list catalog (got: ${tools.map((t) => t.name).join(', ')})`,
      ).toBe(true);

      // --- tools/call: list_namespaces, scoped explicitly to our cluster ---
      // (other agents/suites may have connected additional clusters to this
      // shared org right now - the aggregator only auto-defaults the cluster
      // arg when exactly one is connected, so pass it explicitly.)
      const callRes = await api.post('/mcp', {
        headers: sessionHeaders,
        data: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_namespaces', arguments: { cluster: clusterId } },
        },
      });
      expect(callRes.status(), 'mcp tools/call list_namespaces').toBe(200);
      const callBodyRaw = await callRes.text();
      const callBody = parseRPC(callBodyRaw);
      expect(callBody.error, `tools/call returned a JSON-RPC error: ${JSON.stringify(callBody.error)}`).toBeUndefined();
      const result = callBody.result;
      expect(
        result?.isError,
        `list_namespaces tool call came back isError: ${JSON.stringify(result)}`,
      ).toBeFalsy();

      const textContent = (result?.content ?? []).find((c: { text?: string }) => c.text)?.text;
      expect(textContent, 'tools/call result had no text content block to parse').toBeTruthy();
      const namespaces = JSON.parse(textContent) as Array<{ name: string; status: string }>;
      expect(namespaces.length, 'list_namespaces returned zero namespaces - suspiciously empty for a live cluster').toBeGreaterThan(0);

      // Ground truth, independent of anything the hub or radar cached.
      const kubectlNamespaces = (JSON.parse(kubectl('get', 'namespaces', '-o', 'json')).items as Array<{
        metadata: { name: string };
        status: { phase: string };
      }>).map((ns) => ({ name: ns.metadata.name, status: ns.status.phase }));

      const mcpNames = namespaces.map((n) => n.name).sort();
      const kubectlNames = kubectlNamespaces.map((n) => n.name).sort();
      expect(
        mcpNames,
        `MCP list_namespaces (via the hub -> tunnel -> radar chain) doesn't match \`kubectl get namespaces\`.\n` +
          `mcp: ${mcpNames.join(', ')}\nkubectl: ${kubectlNames.join(', ')}`,
      ).toEqual(kubectlNames);

      // Phase (status) is the other field the tool reports - check it agrees
      // too, not just the name set, so a tool that returned the right names
      // with stale/wrong status would still be caught.
      const kubectlPhaseByName = new Map(kubectlNamespaces.map((n) => [n.name, n.status]));
      for (const ns of namespaces) {
        expect(
          ns.status,
          `namespace ${ns.name}: MCP reported status "${ns.status}" but kubectl reports "${kubectlPhaseByName.get(ns.name)}"`,
        ).toBe(kubectlPhaseByName.get(ns.name));
      }

      await testInfo.attach('mcp-list-namespaces-call.json', {
        body: JSON.stringify(
          {
            request: { method: 'tools/call', name: 'list_namespaces', arguments: { cluster: clusterId } },
            response: JSON.parse(sseExtractJSON(callBodyRaw)),
            kubectl_ground_truth: kubectlNamespaces,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });

      // --- revoke, and prove it actually took effect on this exact chain ---
      await revokePAT(page, patId);

      const postRevokeRes = await api.post('/mcp', {
        headers: sessionHeaders,
        data: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      });
      expect(
        postRevokeRes.status(),
        'a revoked PAT must be rejected by /mcp, not silently still accepted',
      ).toBe(401);
    } catch (e) {
      // Best-effort cleanup on assertion failure too - never leave a live
      // token behind in the shared org just because an earlier assertion
      // threw before the planned revoke ran.
      await revokePAT(page, patId).catch(() => {});
      throw e;
    }
  });

  test('the MCP endpoint rejects unauthenticated and bad-token requests', async () => {
    const initPayload = {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'radar-hub-e2e', version: '0' } },
    };

    const noAuthRes = await api.post('/mcp', { headers: MCP_HEADERS, data: initPayload });
    expect(noAuthRes.status(), 'mcp request with no credentials at all must be rejected').toBe(401);

    // Correctly-shaped (rhp_-prefixed) but nonexistent token - proves the
    // hub actually validates against the PAT store rather than accepting
    // anything shaped like a token.
    const badTokenRes = await api.post('/mcp', {
      headers: { ...MCP_HEADERS, Authorization: 'Bearer rhp_0000000000000000000000000000000000000000000' },
      data: initPayload,
    });
    expect(badTokenRes.status(), 'mcp request with an invalid PAT must be rejected').toBe(401);

    // A bearer that isn't PAT-shaped at all - the auth path should reject it
    // the same way, not fall back to treating it as a session cookie.
    const garbageTokenRes = await api.post('/mcp', {
      headers: { ...MCP_HEADERS, Authorization: 'Bearer not-a-real-token' },
      data: initPayload,
    });
    expect(garbageTokenRes.status(), 'mcp request with a garbage bearer token must be rejected').toBe(401);
  });
});
