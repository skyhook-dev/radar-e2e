import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { assertClusterConnected, clusterId, kubectl } from './helpers';

// Pod exec is the suite's third transport. Plain request/response is covered
// by most specs, server-sent events by logs.spec.ts, and this is the last
// one: a bidirectional WebSocket, upgraded mid-connection and multiplexed
// over the same yamux tunnel as everything else. A tunnel that serves GETs
// and even one-way SSE streams just fine can still fail to carry an upgraded,
// two-way socket - so it needs its own coverage.
//
// The chain under test:
//   browser xterm <-> hub (WS upgrade, proxied through the tunnel) <->
//   radar's handlePodExec (internal/server/exec.go) <-> kubelet exec <->
//   the pod's shell, and back.
//
// Rendering note: @xterm/xterm v6 (used here) has no canvas renderer at all -
// packages/k8s-ui/src/components/dock/TerminalTab.tsx opens a plain `XTerm`
// with no rendererType override, and xterm's own _createRenderer() always
// instantiates DomRenderer. Every visible cell is real DOM text under
// `.xterm-rows`, so ordinary text locators can read it - no accessibility
// mode, no OCR, no reaching into the XTerm instance required.

const execNamespace = 'e2e-exec';
const runId = randomBytes(4).toString('hex');
const podName = `exec-probe-${runId}`;
const containerName = 'probe';
const marker = `e2e-exec-${runId}`;

/** A single long-lived pod with a shell - the whole point is exec'ing into
 * it, so there is nothing else worth deploying alongside it. */
function deployExecPod() {
  const manifest = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${execNamespace}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${execNamespace}
  labels:
    app: ${podName}
spec:
  containers:
    - name: ${containerName}
      # Pulled from Google's Docker Hub mirror rather than Docker Hub itself:
      # anonymous pulls from shared CI egress addresses are rate-limited.
      image: mirror.gcr.io/library/busybox:1.36
      command: ["/bin/sh", "-c", "sleep infinity"]
`.trimStart();

  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-exec-'));
  const manifestPath = path.join(dir, 'exec-pod.yaml');
  writeFileSync(manifestPath, manifest);
  try {
    kubectl('apply', '-f', manifestPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  kubectl('-n', execNamespace, 'wait', 'pod', podName, '--for=condition=Ready', '--timeout=60s');
}

/** Opens the Terminal tab for our probe pod and waits for the WebSocket
 * upgrade to complete. Each test calls this fresh (new page -> new
 * DockProvider -> new WS session), so sessions never bleed across tests. */
async function openTerminalForPod(page: Page) {
  await page.goto('/');
  await assertClusterConnected(page);
  await page.goto(`/c/${clusterId}/workload/pods/${execNamespace}/${podName}`);

  // The Terminal button lives per-container in the "Containers" section and
  // only renders once the container reaches Running - so waiting for it also
  // waits out the resource fetch + RBAC (canExec) check. It's icon-only with
  // no accessible name (a bare <button><TerminalIcon/></button>, tooltip text
  // only exists in a hover-triggered portal) - and the same lucide Terminal
  // icon is reused ambiguously elsewhere on this exact page (the top nav's
  // "Logs" tab icon, "Logs" quick-links on the Runtime/Pods cards), so the
  // icon class alone is not a safe locator. Scoping to the container's own
  // card (identified by its name) disambiguates it.
  const containerCard = page.locator('.card-inner-lg').filter({ hasText: containerName });
  const openTerminalButton = containerCard.locator('button:has(svg.lucide-terminal)');
  await expect(openTerminalButton).toBeVisible({ timeout: 30_000 });
  await openTerminalButton.click();

  // Dock's mini status dot: title flips Connecting -> Connected once the
  // upgraded socket is open end-to-end (hub tunnel -> radar -> kubelet exec).
  await expect(
    page.locator('[title="Connected"]'),
    'terminal never reached "Connected" - the WebSocket upgrade through the tunnel did not complete',
  ).toBeVisible({ timeout: 30_000 });

  // xterm.focus() runs in the ws.onopen handler, but click the visible
  // terminal surface too so keyboard input is unambiguously targeted at it
  // rather than whatever the browser last focused.
  await page.locator('.xterm-screen').click();
}

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through e2e/browser/run.sh');
  deployExecPod();
});

test.afterAll(() => {
  kubectl('-n', execNamespace, 'delete', 'pod', podName, '--ignore-not-found', '--wait=false');
});

test('typed input reaches the pod and its real output renders in the terminal', async ({ page }, testInfo) => {
  await openTerminalForPod(page);

  // hostname inside the container is the pod name by default (no
  // hostnameOverride set in the manifest) - so this line's output is not
  // just "something we typed came back", it is the pod's own identity,
  // independently checkable against `kubectl get pod`. Keystrokes only
  // appear on screen because the remote pty echoes them back over the
  // WebSocket (xterm never renders input locally - see TerminalTab.tsx's
  // xterm.onData, which sends but never calls xterm.write) - so both the
  // echoed command line and its output prove data flowing in both
  // directions over the upgraded socket, not just one.
  //
  // insertText (not keyboard.type): xterm listens for real "keydown" to
  // build its input, but also accepts a plain browser "input" event whose
  // inputType is insertText (xterm.js's _inputEvent - the path built for
  // mobile/autofill text insertion), sending the whole string as one data
  // event. keyboard.type()'s per-character synthetic keydown/keyup pairs
  // raced xterm's key-handled bookkeeping under CDP's dispatch timing and
  // silently dropped characters between the browser and xterm itself -
  // before the data ever reached the WebSocket - which is a test-harness
  // artifact, not the tunnel transport this spec exists to check.
  const terminalRowsForPrompt = page.locator('.xterm-rows');

  // "Connected" means the WebSocket upgrade completed - it does NOT mean the
  // remote shell is ready to read. Typing into that gap sends bytes nothing is
  // listening for yet, and they are simply lost: the test then fails as though
  // the transport were broken. Waiting for the pty's own prompt to render is
  // the first proof that the far end is alive and echoing.
  await expect(
    terminalRowsForPrompt,
    'the remote shell never printed a prompt - the exec session opened but the pty never came up',
  ).toContainText('#', { timeout: 30_000 });

  const command = `echo ${marker} host=$(hostname)`;
  await page.keyboard.insertText(command);
  await page.keyboard.press('Enter');

  // One re-send if the first burst produced nothing. A dropped keystroke burst
  // between the browser and xterm is a harness artifact, and `echo` is
  // idempotent, so retrying costs nothing - while a genuinely broken transport
  // still fails below, because no amount of re-sending would produce output.
  const rendered = await terminalRowsForPrompt
    .getByText(new RegExp(`${marker} host=${podName}`))
    .first()
    .isVisible({ timeout: 8_000 })
    .catch(() => false);
  if (!rendered) {
    await page.locator('.xterm-screen').click();
    await page.keyboard.insertText(command);
    await page.keyboard.press('Enter');
  }

  // .first(): the marker legitimately renders on two separate rows - the
  // echoed command line (remote pty echo) and, below it, the command's own
  // output line - either one is proof the round trip completed, so matching
  // more than one row is not ambiguity, it's redundant confirmation.
  const terminalRows = page.locator('.xterm-rows');
  await expect(
    terminalRows.getByText(new RegExp(`${marker} host=${podName}`)).first(),
    `"${marker} host=${podName}" never appeared in the terminal - either input never reached the pod's shell, or its output never made it back`,
  ).toBeVisible({ timeout: 20_000 });

  await testInfo.attach('exec-command-output.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('the terminal reports a clean disconnect when the remote shell exits', async ({ page }, testInfo) => {
  await openTerminalForPod(page);

  // Prove the session is genuinely live before ending it - otherwise a
  // session that silently died before we typed "exit" would look identical
  // to one that shut down cleanly in response to it.
  await page.keyboard.insertText(`echo ${marker}-alive`);
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.xterm-rows').getByText(new RegExp(`${marker}-alive`)).first(),
    'session never proved itself live before the exit was sent',
  ).toBeVisible({ timeout: 20_000 });

  // internal/server/exec.go: when the shell's StreamWithContext returns nil
  // (clean process exit, as opposed to an error), the server sends no error
  // frame - it just closes the WebSocket. TerminalTab's ws.onclose then sets
  // isConnected=false/isConnecting=false (title -> "Disconnected") and shows
  // Reconnect, with no error banner - that combination is what distinguishes
  // "the remote process ended" from a broken connection.
  await page.keyboard.insertText('exit');
  await page.keyboard.press('Enter');

  await expect(
    page.locator('[title="Disconnected"]'),
    'terminal never reported Disconnected after the remote shell process exited',
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: /reconnect/i }),
    'no Reconnect affordance appeared after the remote shell exited',
  ).toBeVisible();

  // A clean exit must not be presented as a connection failure - those are
  // mutually exclusive branches in TerminalTab (error state swaps the whole
  // panel for a red "Failed to connect" screen with a Retry button).
  await expect(page.getByText(/failed to connect/i)).toHaveCount(0);

  await testInfo.attach('exec-clean-exit.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
