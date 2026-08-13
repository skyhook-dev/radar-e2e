import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertClusterConnected,
  authStatePath,
  captureSurface,
  dashboardCardText,
  gotoWhenNotRateLimited,
  kubectl,
} from './helpers';

// A certificate starts running out, and the operator has to find out in time.
//
// certs-checks.spec.ts already proves the Certs PAGE reflects a real TLS secret
// in detail - issuer, SANs, days left, health bucket. What nothing covered is
// the path an operator is actually on: they do not open /certs on a hunch, they
// see it on the dashboard they already had open, click through, and expect it
// to disappear once they have rotated it.
//
// So this walks the whole arc against a real self-signed certificate:
//
//   1. Before: the dashboard says nothing is expiring.
//   2. A certificate valid for 5 days is created in the cluster.
//   3. The dashboard card has to change on its own - naming the certificate,
//      the cluster it is in, and roughly how long is left.
//   4. Its own link has to lead to the Certs page, which must list it.
//   5. After the secret is deleted, the dashboard has to go back to saying
//      nothing is expiring.
//
// Step 5 is the half that gets forgotten. A dashboard that lights up and never
// goes dark is a dashboard people stop reading.
//
// Verified against the running product before being written: the card reads
// "CERTIFICATES | Nothing expiring in 30 days" beforehand, and
// "CERTIFICATES | 1 | expiring in 30 days | <name> | <cluster> | manual | 4d"
// within about ten seconds of the secret being created.

test.use({ storageState: authStatePath });
test.setTimeout(420_000);
test.describe.configure({ mode: 'serial' });

const CERTS_NAMESPACE = 'e2e-certs';
const SECRET = `journey-cert-${Date.now()}`;
const COMMON_NAME = `${SECRET}.certs.e2e.test`;
const DAYS_VALID = 5;

let tmpDir = '';

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

test.beforeAll(() => {
  const existing = kubectl('get', 'namespace', CERTS_NAMESPACE, '--ignore-not-found', '-o', 'name');
  if (!existing) kubectl('create', 'namespace', CERTS_NAMESPACE);

  tmpDir = mkdtempSync(path.join(tmpdir(), 'e2e-journey-certs-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', String(DAYS_VALID),
      '-nodes',
      '-subj', `/CN=${COMMON_NAME}`,
      '-addext', `subjectAltName=DNS:${COMMON_NAME}`,
    ],
    // openssl writes key-generation progress to stderr; dropping it keeps the
    // run output readable.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
});

test.afterAll(() => {
  kubectl('-n', CERTS_NAMESPACE, 'delete', 'secret', SECRET, '--ignore-not-found');
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('an expiring certificate reaches the dashboard on its own, and leads to the Certs page', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);
  await gotoWhenNotRateLimited(page, '/');

  // The starting point matters: if something else in this cluster is already
  // expiring, "the card mentions a certificate" would prove nothing.
  const before = await dashboardCardText(page, '/certs');
  expect.soft(before, 'the dashboard has no Certificates card at all').not.toBe('NO CARD');
  const startedClean = /nothing expiring/i.test(before);
  await captureSurface(page, testInfo, 'journey-cert-dashboard-before');

  kubectl(
    '-n', CERTS_NAMESPACE,
    'create', 'secret', 'tls', SECRET,
    `--cert=${path.join(tmpDir, 'cert.pem')}`,
    `--key=${path.join(tmpDir, 'key.pem')}`,
  );

  // No reload loop by hand - the dashboard is re-opened each poll, which is
  // what an operator with the tab open would experience within a minute.
  await expect
    .poll(
      async () => {
        await gotoWhenNotRateLimited(page, '/');
        return dashboardCardText(page, '/certs');
      },
      {
        message:
          `a certificate expiring in ${DAYS_VALID} days was created in ${CERTS_NAMESPACE} and the dashboard ` +
          `Certificates card never mentioned it - an operator watching the dashboard would miss the rotation`,
        timeout: 180_000,
        intervals: [5000, 5000, 10_000],
      },
    )
    .toContain(SECRET);

  const after = await dashboardCardText(page, '/certs');
  if (startedClean) {
    expect
      .soft(after, 'the Certificates card still says nothing is expiring while naming a certificate that is')
      .not.toMatch(/nothing expiring/i);
  }
  // It has to say how urgent this is, not merely that something exists.
  expect
    .soft(after, `the Certificates card names ${SECRET} but never says how long is left on it`)
    .toMatch(/\d+\s*d\b|\bexpir/i);

  await captureSurface(page, testInfo, 'journey-cert-dashboard-alerting');

  // And the card has to be a way IN, not just a notification.
  await gotoWhenNotRateLimited(page, '/certs');
  await expect
    .poll(async () => (await bodyText(page)).includes(SECRET), {
      message: `the dashboard points at the Certs page for ${SECRET}, but the page does not list it`,
      timeout: 90_000,
      intervals: [3000, 5000],
    })
    .toBe(true);

  const certsPage = await bodyText(page);
  expect
    .soft(certsPage, 'the Certs page does not say which namespace the certificate lives in')
    .toContain(CERTS_NAMESPACE);

  await captureSurface(page, testInfo, 'journey-cert-page');
});

test('rotating the certificate away clears it from the dashboard', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertClusterConnected(page);

  // The fix an operator would apply: the old secret goes.
  kubectl('-n', CERTS_NAMESPACE, 'delete', 'secret', SECRET, '--ignore-not-found');

  await expect
    .poll(
      async () => {
        await gotoWhenNotRateLimited(page, '/');
        return dashboardCardText(page, '/certs');
      },
      {
        message:
          `${CERTS_NAMESPACE}/${SECRET} was deleted from the cluster but the dashboard still warns about it - ` +
          `a warning that outlives the problem is one people learn to ignore`,
        timeout: 180_000,
        intervals: [5000, 5000, 10_000],
      },
    )
    .not.toContain(SECRET);

  // Longer than the dashboard's budget on purpose. The card above cleared
  // within a minute while the page had not caught up yet - they are fed by
  // different paths with different refresh intervals, and 90s was enough for
  // one and not the other. What is being asserted is that the page DOES catch
  // up, not how fast; a page that never drops a deleted certificate is the
  // failure worth reporting.
  await gotoWhenNotRateLimited(page, '/certs');
  await expect
    .poll(
      async () => {
        await gotoWhenNotRateLimited(page, '/certs');
        return (await bodyText(page)).includes(SECRET);
      },
      {
        message:
          `${CERTS_NAMESPACE}/${SECRET} was deleted from the cluster and has already cleared from the dashboard, ` +
          `but the Certs page still lists it`,
        timeout: 240_000,
        intervals: [10_000, 10_000, 15_000],
      },
    )
    .toBe(false);

  await captureSurface(page, testInfo, 'journey-cert-resolved');
});
