import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertClusterConnected, clusterId, demoDeployment, demoNamespace, kubectl, captureSurface } from './helpers';

// Two fleet surfaces, two different radar endpoints, so the "real data"
// question has a different answer for each:
//
//   - /certs reads radar's own /api/certificates (pkg/certs.Aggregate over
//     cert-manager Certificate CRs + kubernetes.io/tls Secrets), fanned out
//     per-cluster by the hub at /api/fleet/certs.
//   - /checks reads radar's /api/audit best-practice engine, fanned out at
//     /api/fleet/audit. /checks/upgrade is different again: it is
//     per-cluster (not fleet-aggregated) and hits radar's own
//     /api/upgrade-readiness directly, embedded via RadarApp at
//     /c/:id/checks/upgrade.
//
// This is a single-node kind cluster: no cert-manager, no Prometheus, no
// service mesh, no admission webhooks. That shapes what each surface can
// legitimately show here:
//
//   - Certs: kubelet/apiserver PKI on a kind node lives on disk, not as
//     Kubernetes Secrets, and nothing installs cert-manager - so before this
//     spec runs, the fleet has ZERO certificates. A kubernetes.io/tls Secret
//     minted here isn't a supplement to existing data, it IS the entire cert
//     inventory - which is exactly what makes the assertion below meaningful
//     rather than coincidental.
//   - Checks: the audit engine evaluates every unowned Pod and every
//     Deployment/StatefulSet/DaemonSet pod spec, so kube-system's static
//     control-plane pods and its DaemonSets (kube-proxy, kindnet) do fail
//     several checks - but the queue's own provider-managed classifier hides
//     kube-system by default (it's not the customer's to fix). The genuine,
//     default-visible signal is e2e-demo/timeline-probe: a customer-owned
//     Deployment (owned by the timeline suite, read-only from here) with no
//     probes, no resource limits, and no non-root constraint, so it fails
//     several checks for real.
//   - Upgrade impact: with nothing installed that most 1.36 checks look for,
//     they correctly pass or read not_applicable. One check has a genuine
//     live finding regardless of any of that: node-drain-feasibility flags
//     the `radar` pod's own emptyDir volumes ("home", "tmp") - a structural
//     trait of the shipped chart, not incidental cluster noise, and the
//     `radar` deployment is one this harness forbids any agent from
//     touching, so it's stable for the life of the run.

const CERTS_NAMESPACE = 'e2e-certs';

test.beforeAll(() => {
  if (!clusterId) throw new Error('CLUSTER_ID must be set - run through ./run.sh');
});

/**
 * GET against a /api/fleet/* route, retrying on 429. The hub rate-limits all
 * of them together at 30 req/min per user, shared with every other agent
 * currently on this harness - a 429 means "come back shortly", not "broken".
 */
async function fetchFleetJSON<T>(page: Page, urlPath: string): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await page.request.get(urlPath);
    if (res.status() === 429) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      continue;
    }
    expect(res.status(), `${urlPath} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`).toBe(200);
    return res.json();
  }
  throw new Error(`${urlPath} kept returning 429 - the shared fleet rate limit never cleared`);
}

// Mirrors CertExpiryPage's healthLabel() so the test can assert the exact
// text the product renders instead of a loose pattern.
function certHealthLabel(daysLeft: number): string {
  if (daysLeft < 0) return `Expired ${Math.abs(daysLeft)}d ago`;
  if (daysLeft === 0) return 'Expires today';
  if (daysLeft === 1) return '1 day';
  return `${daysLeft} days`;
}

test.describe('Certs', () => {
  const secretName = `e2e-cert-${Date.now()}`;
  const commonName = `${secretName}.certs.e2e.test`;
  let tmpDir: string;

  test.beforeAll(() => {
    const existing = kubectl(
      'get',
      'namespace',
      CERTS_NAMESPACE,
      '--ignore-not-found',
      '-o',
      'jsonpath={.metadata.name}',
    );
    if (existing !== CERTS_NAMESPACE) kubectl('create', 'namespace', CERTS_NAMESPACE);

    // A self-signed cert expiring in 5 days lands in pkg/certs' "unhealthy"
    // bucket (<7 days) - it sorts to the top of the page and can't be
    // mistaken for a coincidentally-healthy pre-existing cert (there are
    // none: this cluster has no cert-manager and no other TLS secrets).
    tmpDir = mkdtempSync(path.join(tmpdir(), 'e2e-certs-'));
    const keyPath = path.join(tmpDir, 'key.pem');
    const certPath = path.join(tmpDir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '5',
        '-nodes',
        '-subj',
        `/CN=${commonName}`,
        '-addext',
        `subjectAltName=DNS:${commonName}`,
      ],
      // openssl writes RSA-generation progress dots to stderr; drop them so
      // the test run stays readable.
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    kubectl(
      '-n',
      CERTS_NAMESPACE,
      'create',
      'secret',
      'tls',
      secretName,
      `--cert=${certPath}`,
      `--key=${keyPath}`,
    );
  });

  test.afterAll(() => {
    kubectl('-n', CERTS_NAMESPACE, 'delete', 'secret', secretName, '--ignore-not-found');
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the Certs page reflects a TLS secret minted in this cluster', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await assertClusterConnected(page);

    type FleetCertsResponse = {
      clusters: {
        cluster_id: string;
        certs?: {
          name: string;
          namespace: string;
          issuer: string;
          domains: string;
          days_left: number | null;
          health: string;
          source: string;
        }[];
      }[];
    };
    type CertRow = NonNullable<FleetCertsResponse['clusters'][number]['certs']>[number];

    // Confirm radar's own /api/certificates leg (and the hub's fanout on top
    // of it, which has its own 5s short-TTL cache) actually picked up the
    // secret before trusting the page to render it.
    let mintedCert: CertRow | null = null;
    await expect
      .poll(
        async () => {
          const data = await fetchFleetJSON<FleetCertsResponse>(page, '/api/fleet/certs');
          const cluster = data.clusters.find((c) => c.cluster_id === clusterId);
          mintedCert = cluster?.certs?.find((c) => c.namespace === CERTS_NAMESPACE && c.name === secretName) ?? null;
          return mintedCert !== null;
        },
        {
          message: `${CERTS_NAMESPACE}/${secretName} never appeared in /api/fleet/certs - radar's /api/certificates leg (or the fleet fanout) isn't picking up a real TLS secret`,
          timeout: 60_000,
          intervals: [2000, 3000, 5000, 5000],
        },
      )
      .toBe(true);

    const cert = mintedCert as unknown as CertRow;
    expect(cert.source, 'a kubernetes.io/tls secret must be classified as source=tls-secret').toBe('tls-secret');
    expect(cert.domains, 'domains should carry the SAN we set').toContain(commonName);
    expect(cert.issuer, 'issuer should carry the self-signed CN we set').toContain(commonName);
    expect(cert.days_left, 'a 5-day cert must have a known expiry').not.toBeNull();
    const daysLeft = cert.days_left as number;
    expect(daysLeft, 'a freshly minted 5-day cert should read somewhere under a week').toBeLessThan(7);
    expect(cert.health, 'under 7 days left must classify as unhealthy').toBe('unhealthy');

    await page.goto('/certs');

    // Narrow to our row by its unique name - the page is fleet-wide by
    // default and other agents may have their own cert data in view.
    await page.getByPlaceholder('Search… (press /)').fill(secretName);

    const table = page.getByRole('table');
    const row = table.getByRole('row').filter({ hasText: secretName });
    // Longer than the 15s default on purpose. The API poll above has already
    // proved the cert is in /api/fleet/certs, so what is left is the page's own
    // fanout - which has its own short-TTL cache in front of it - plus the
    // search debounce. Under a full domain run this took longer than 15s and
    // failed with "no row", which reads as the page not showing a cert the API
    // is serving.
    await expect(row, `no row for cert secret ${secretName} on /certs`).toBeVisible({ timeout: 60_000 });
    await expect(row, 'row must show the namespace the secret actually lives in').toContainText(CERTS_NAMESPACE);
    await expect(row, 'row must tag the cert as a raw TLS secret, not cert-manager').toContainText('TLS secret');

    // Status label is day-granular and read a few seconds after the API
    // probe above, so allow the one adjacent value clock drift could
    // produce rather than pinning the exact number.
    const candidateLabels = [certHealthLabel(daysLeft), certHealthLabel(daysLeft - 1)];
    await expect(
      row,
      `expected the Status cell to read one of [${candidateLabels.join(', ')}], derived from the live days_left=${daysLeft}`,
    ).toContainText(new RegExp(candidateLabels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));

    // Prove the page's OWN health classification agrees with the data, not
    // just that we can compute a label that happens to match: filtering to
    // "Healthy" must hide the row; filtering to "Expired / soon" must not.
    const healthyTile = page.getByRole('button', { name: /Healthy/ });
    await healthyTile.click();
    await expect(
      page.getByText('No certs match the current filter'),
      'a cert expiring in under a week must not classify as Healthy',
    ).toBeVisible();
    await healthyTile.click();

    const unhealthyTile = page.getByRole('button', { name: /Expired \/ soon/ });
    await unhealthyTile.click();
    await expect(row, 'the row must still show once filtered to the Expired/soon (unhealthy) bucket').toBeVisible();

    await captureSurface(page, testInfo, 'certs-list-expiring-soon');
  });
});

test.describe('Checks', () => {
  // This spec used to assert against e2e-demo/timeline-probe, a workload owned
  // by the timeline scenario. That made it depend on ANOTHER spec's fixture
  // being present AND already classified as customer-owned by the audit
  // engine - and when this ran early in a full-suite pass, before that
  // classification had settled, the queue had zero actionable findings and
  // correctly rendered no card. The test failed for someone else's timing.
  // Owning the fixture removes the coupling: this workload violates several
  // checks by construction (no probes, no resource limits, no non-root
  // constraint) and lives in this spec's own namespace.
  const checksWorkload = `checks-probe-${Date.now()}`;

  test.beforeAll(() => {
    const existing = kubectl(
      'get',
      'namespace',
      CERTS_NAMESPACE,
      '--ignore-not-found',
      '-o',
      'jsonpath={.metadata.name}',
    );
    if (existing !== CERTS_NAMESPACE) kubectl('create', 'namespace', CERTS_NAMESPACE);
    kubectl(
      '-n',
      CERTS_NAMESPACE,
      'create',
      'deployment',
      checksWorkload,
      '--image=registry.k8s.io/pause:3.9',
      '--replicas=1',
    );
    kubectl('-n', CERTS_NAMESPACE, 'rollout', 'status', `deployment/${checksWorkload}`, '--timeout=120s');
  });

  test.afterAll(() => {
    kubectl('-n', CERTS_NAMESPACE, 'delete', 'deployment', checksWorkload, '--ignore-not-found', '--wait=false');
  });

  test('the Checks queue surfaces a real finding from a live customer-owned workload', async ({ page }, testInfo) => {
    // Longer than the 120s wait below: a locator timeout above the test
    // timeout never gets to run, which is exactly how an earlier attempt to
    // give this check more room silently did nothing.
    test.setTimeout(180_000);
    await page.goto('/');
    await assertClusterConnected(page);

    type FleetAuditResponse = {
      clusters: {
        cluster_id: string;
        checks?: {
          checkID: string;
          title: string;
          findings: { resource: { namespace?: string; name: string; kind: string } }[];
        }[];
      }[];
    };

    // The audit engine evaluates on its own cadence, so poll until it has
    // seen the workload rather than assuming it already has.
    let cluster: FleetAuditResponse['clusters'][number] | undefined;
    await expect
      .poll(
        async () => {
          const data = await fetchFleetJSON<FleetAuditResponse>(page, '/api/fleet/audit');
          cluster = data.clusters.find((c) => c.cluster_id === clusterId);
          return (cluster?.checks ?? []).some((c) =>
            c.findings.some((f) => f.resource.namespace === CERTS_NAMESPACE && f.resource.name === checksWorkload),
          );
        },
        {
          message: `the audit engine never reported any finding for ${CERTS_NAMESPACE}/${checksWorkload}, a workload with no probes, no limits and no non-root constraint`,
          timeout: 120_000,
          intervals: [3000, 5000, 5000],
        },
      )
      .toBe(true);

    // demoDeployment (e2e-demo/timeline-probe) is owned by the timeline
    // suite and is customer-owned (not kube-system), so it's real,
    // default-visible queue signal regardless of which agent's turn it is
    // to run: no probes, no resource limits, no non-root constraint.
    // A workload can trip SEVERAL checks, and which one is listed first is not
    // stable - it depends on what else is in the cluster, so it changed the
    // moment related specs began sharing one. Taking the first match then
    // asserting its card is visible couples this test to that ordering: the
    // queue hides a check whose findings are all platform-managed, so picking
    // such a check fails for a reason that has nothing to do with the product.
    //
    // Collect every check carrying a finding for this workload and require at
    // least one to reach the queue. That is the actual claim - a real finding
    // from a customer-owned workload is visible to a user - and it no longer
    // depends on which check happens to sort first.
    const candidates = (cluster!.checks ?? []).filter((c) =>
      c.findings.some((f) => f.resource.namespace === CERTS_NAMESPACE && f.resource.name === checksWorkload),
    );
    expect(
      candidates.length,
      `no audit check carries a finding for ${CERTS_NAMESPACE}/${checksWorkload}`,
    ).toBeGreaterThan(0);
    testInfo.annotations.push({
      type: 'checks carrying this workload',
      description: candidates.map((c) => `${c.checkID} (${c.title})`).join(', '),
    });

    let check: (typeof candidates)[number] | undefined;
    const notVisible: string[] = [];
    for (const candidate of candidates) {
      await page.goto(`/checks?check=${encodeURIComponent(candidate.checkID)}`);
      // Shorter per candidate than the old single 120s wait, because there are
      // now several to try; the total budget is similar.
      // expect().toBeVisible(), not locator.isVisible(): the latter returns
      // immediately and its timeout option does nothing, so it answers "is it
      // on screen right now" before the queue has rendered. Getting that wrong
      // made all 11 candidates report absent in 3.5s and looked exactly like a
      // product defect.
      const rendered = await expect(page.getByText(candidate.title, { exact: true }).first())
        .toBeVisible({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (rendered) {
        check = candidate;
        break;
      }
      notVisible.push(`${candidate.checkID} (${candidate.title})`);
    }

    expect(
      check,
      `the Checks queue rendered no card for any check carrying a finding on ${CERTS_NAMESPACE}/${checksWorkload}. ` +
        `Tried: ${notVisible.join(', ')}. The queue hides checks whose findings are all platform-managed, so this ` +
        `means every check this workload trips was classified that way - a customer-owned workload with a real ` +
        `finding is invisible to the user.`,
    ).toBeTruthy();

    // Generous window, single navigation. Radar caches its checks computation
    // per cluster, so the fleet API above can be fresher than the payload the
    // page fetches: for a while the page can still hold a result in which the
    // only findings for this check are platform-managed, and the queue hides
    // those by default - so the card is legitimately absent. The page polls on
    // its own, so waiting (rather than reloading in a loop) lets it catch up.
    await expect(
      page.getByText(check!.title, { exact: true }).first(),
      `Checks queue never rendered a card titled "${check!.title}" (checkID=${check!.checkID}) - if the only findings for it were platform-managed, the queue hides them by default`,
    ).toBeVisible({ timeout: 120_000 });

    const findingText = `${CERTS_NAMESPACE} / ${checksWorkload}`;
    await expect(
      page.getByText(findingText, { exact: true }).first(),
      `"${check!.title}" card never listed ${findingText} among its affected resources`,
    ).toBeVisible();

    await captureSurface(page, testInfo, 'checks-queue-actionable-finding');
  });

  test('the Upgrade impact view surfaces real evidence from this cluster', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await assertClusterConnected(page);

    type UpgradeReadinessResponse = {
      currentVersion: string;
      targetVersion: string;
      checks: {
        id: string;
        title: string;
        findings: {
          title: string;
          resource?: { kind: string; namespace?: string; name: string };
        }[];
      }[];
    };

    const res = await page.request.get(`/c/${clusterId}/api/upgrade-readiness`);
    expect(res.status(), `/c/${clusterId}/api/upgrade-readiness returned ${res.status()}`).toBe(200);
    const data: UpgradeReadinessResponse = await res.json();

    await page.goto(`/c/${clusterId}/checks/upgrade`);

    // Version header always reflects live cluster state, whichever branch
    // below applies.
    const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(
      page.getByText(new RegExp(`Kubernetes ${escaped(data.currentVersion)}.*${escaped(data.targetVersion)}`)),
      'page header should name the live current -> target Kubernetes versions',
    ).toBeVisible({ timeout: 30_000 });

    const checkWithFinding = data.checks.find((c) => c.findings.length > 0);

    if (checkWithFinding) {
      const finding = checkWithFinding.findings[0];
      // Expand the check row, then the finding-type row inside it - both are
      // real accordion toggles in this view (unlike the fleet Checks queue,
      // whose findings render unconditionally).
      await page.getByText(checkWithFinding.title, { exact: true }).first().click();
      const findingTitle = page.getByText(finding.title, { exact: true }).first();
      await expect(
        findingTitle,
        `expanding "${checkWithFinding.title}" never revealed finding "${finding.title}"`,
      ).toBeVisible();

      if (finding.resource) {
        await findingTitle.click();
        const resourceLabel = finding.resource.namespace
          ? `${finding.resource.namespace}/${finding.resource.name}`
          : finding.resource.name;
        await expect(
          page.getByText(resourceLabel, { exact: true }).first(),
          `finding "${finding.title}" never showed its real resource ${resourceLabel}`,
        ).toBeVisible();
      }
    } else {
      // Honest empty state: every reviewed check for this target genuinely
      // passed or doesn't apply here. This is the "correctly reports
      // nothing" path, not a fallback taken because we couldn't find real
      // data - see the file-header comment for why the harness normally
      // does NOT land here (the radar pod's own emptyDir volumes).
      await expect(
        page.getByText(new RegExp(`No blockers found for Kubernetes ${escaped(data.targetVersion)}`)),
        'no check had findings, so the view should show its honest all-clear state',
      ).toBeVisible();
    }

    await captureSurface(page, testInfo, 'upgrade-impact-blocker');
  });
});
