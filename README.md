# radar-e2e

End-to-end browser tests for the **radar + radar-hub** integration.

Stands up the self-hosted hub on a throwaway kind cluster, connects a real radar
over the tunnel, and drives the web UI with Playwright. Everything is built from
the current `main` of `radar-hub`, `radar-hub-web` and `radar`, so this watches
the integration between the three codebases rather than the released artifacts.

This repo holds only the harness - the code under test is checked out per run. It
is public so that GitHub-hosted runner minutes are free; at 12 runs a day that is
the difference between free and roughly $23/month.

`radar-hub`'s own `deploy/local-liveness` covers connection liveness at the API
level. This is the browser-level counterpart and does not repeat those scenarios.

## What it needs

| Requirement | Why |
|---|---|
| docker, kind, kubectl, helm, node 22 | build images, run the cluster, install the chart |
| `RADAR_HUB_LICENSE` | without a license the hub serves a license-required screen and nothing is testable |
| checkouts of `radar-hub-web`, `helm-charts`, `radar` | images are built from source; the chart is installed from the source tree |
| jq | the harness talks to the hub API to register a cluster and mint its token |

Sibling checkouts default to `../radar-hub`, `../radar-hub-web`, `../helm-charts`,
`../radar`. Override with `HUB_DIR`, `HUB_WEB_DIR`, `CHARTS_DIR`, `RADAR_DIR`.

## Run it

```bash
export RADAR_HUB_LICENSE='<jwt>'
./run.sh all     # build + cluster + install + connect radar + tests
./run.sh test    # re-run tests against a stack that is already up
./run.sh logs    # pod status + hub logs
./run.sh down    # delete the cluster
```

The hub is reached at `http://localhost:18080` through a `kubectl port-forward`
that `up` starts in the background - kind has no load balancer, and port-forward
behaves the same on a laptop and on a CI runner.

## What it covers

Each scenario runs as its own CI job with its own cluster - created fresh for
that job and thrown away after - so they finish in the time of the slowest
rather than the sum, and a wedged cluster cannot take the others down. Locally, `SPECS=timeline ./run.sh test` runs one of them.

13 scenarios, 116 tests, each scenario run twice - once against a hub built from
main and once against the published release.

Where a surface makes a claim about the cluster, the claim is checked against
the cluster: resource counts and detail fields against `kubectl get`, Helm tabs
against `helm get values/manifest/history`, the Clusters table and the
organisation pages against the hub's own API. "The panel opened" is not
evidence that anything in it is true.

| Scenario | What it proves |
|---|---|
| `shell` | the app shell, the home dashboard, and that every dashboard card agrees with the page it links to; the fleet-wide pages render real fleet state; search boxes, state filters, sorting, grouping and drill-downs do what they say |
| `fleet` | issue detection from live cluster state, the three triage actions (mark seen, snooze, dismiss) and their undo, the issue detail drawer, alerts firing on a real condition, certificates and checks read from the cluster |
| `workloads` | resource browsing across nine kinds and their tabs, and mutating actions |
| `helm` | releases listed with the chart version and status `helm list` reports, upgrades that change the cluster and advance the revision, and rollbacks |
| `observability` | topology counts match `kubectl get` and follow the cluster live; capacity reports the node's real allocatable resources and counts pods blocked on scheduling (not pods blocked on an image pull); traffic and cost explain honestly why they have no data here rather than showing a confident zero |
| `journey` | whole scenarios end to end: a workload breaks, is found on every surface, is triaged and then fixed - and the issue clears everywhere; a certificate nears expiry, reaches the dashboard, and clears when rotated; a scale reaches Applications, Resources and Topology and comes back down |
| `platform` | the header search finds what the cluster really has and invents nothing; the notification inbox records issues arriving AND clearing, and can be cleared |
| `diagnostics` | diagnosis, log streaming and an interactive pod terminal, all proxied end to end |
| `multi-cluster` | a second cluster connects and the fleet aggregates across both, including honest reporting when one is offline |
| `cluster-lifecycle` | an agent that stops is reported disconnected rather than stale-connected, comes back on its own, and a rotated token drops the live tunnel |
| `admin` | onboarding, org administration and settings, including an install wizard that names this hub's real agent URL |
| `gitops` | CRD-backed GitOps inventory, on its own cluster because it installs CRDs |
| `known-issues` | pins defects found here so they turn red when fixed, not silently absorbed |

Assertions are written against facts read from the cluster at the time of the
test (`helm list`, `kubectl get`), not against fixtures, so they track reality
instead of a snapshot taken when the test was written.

Not covered: hub-side timeline retention. `HUB_TIMELINE_BACKEND` is never set by
the chart (and there is no `extraEnv`), so retention is off and
`/c/{id}/api/timeline/*` delegates to the in-cluster radar. That is what the
shipped chart does, so it is what this tests. SSO/OIDC and billing need
infrastructure this harness does not stand up.

## Two variants, side by side

Every scenario runs twice per cycle:

- **main** - images built from the current `main` of all three repos.
- **published** - the latest released chart and images from the public registry.

The published leg deliberately does not wait for the build, so it starts
immediately. Comparing the two answers the question that matters before a
release: *is anything that works today going to break when this is published, and
which of the things I fixed are not out yet?* A scenario that fails only on
`published` is normally a feature that exists in `main` and has not shipped, and
it goes green when main is published.

## Visual review

Specs capture screenshots at deliberate moments (not on a timer), each in light
**and** dark theme, and the `gallery` job assembles every run into one
self-contained `index.html`: main on the left, published on the right, one
click to swap themes, console errors reported per scenario. Download the
`visual-review` artifact and open `index.html` - no server, no network.

A test that fails also has its whole session recorded, embedded in the same page
under the scenario it belongs to and paired across variants like the
screenshots, with a download link on each. The screenshots say what a surface
looked like; the recording says how it got there, which is the question worth
answering when something broke. Recording every test was tried and dropped: the
recordings nobody opens are the ones for tests that passed, and they were
spending the budget the screenshots need. They load lazily, so nothing is
fetched until you press play.

Recordings are made at 854px wide, the smallest size where the product's body
text stays readable, and the gallery job then does two things to them: caps the
frame rate at 8fps (Playwright records at a fixed 25fps with no way to change
it) and drops frames that are near-identical to the one before.

That second step is where most of the saving comes from. A test spends the bulk
of its wall time waiting on a screen that is not changing: of one real 77s
recording, about 9s contained any visible change at all. Removing the idle took
it from 3.3 MB to 86 KB. The consequence to know about is that a recording plays
back much shorter than its test took, so the page states this and shows the real
test duration rather than the video's.

The order matters and is not interchangeable: mpdecimate keeps every distinct
frame at whatever rate it is fed, so on a busy recording it alone produced a
larger file than a plain frame-rate cap. Capping first and decimating second
beats either on its own.

Without ffmpeg on PATH the recordings still ship, just uncompressed, and the
build says so. The console line and page header report the before and after.

Override with `E2E_VIDEO=on|retain-on-failure|off` - `on` records every test,
which is useful when you want a walkthrough of a passing flow.

## Distribution tests

`.github/workflows/dist-e2e.yml` is a separate, daily suite that asks a
different question: not "does main work" but "does what a user installs work".
Nothing in it is built from source. 14 jobs across Linux, macOS and Windows
cover Homebrew (formula and cask, both architectures), the `install.sh` and
`install.ps1` one-liners, `.deb` and `.rpm` packages, Scoop, desktop-app code
signing and launch, and a `cli-e2e` project that drives the published CLI
against a real kind cluster.

These fail in ways the browser suite cannot see: stale manifests, unsigned
apps, unversioned binaries, installers that verify nothing they download.
Findings that are real but not yet fixed are pinned - the job reports them as
warnings and fails if the condition changes, so a fix cannot be absorbed
silently. See `KNOWN-ISSUES.md`.

## CI

`.github/workflows/e2e.yml` runs the browser suite every 2 hours and on manual
dispatch. It differs from a local run in three ways: images are built by
cache-aware build steps and `SKIP_BUILD=1` tells `run.sh` to skip its own build;
the private `radar-hub-web` checkout uses a GitHub App token minted per job; and
the Playwright report is uploaded on success as well as failure, because its
attachments are the only evidence anyone can look at afterwards.

Manual and scheduled runs are in separate concurrency lanes, so neither
cancels the other. A manual dispatch still supersedes an earlier manual
dispatch, which is what you want while iterating on a change. The cost is that
an overlapping pair shares the 20 concurrent job slots standard runners allow,
so both take longer than either would alone.

Repository secrets it needs:

| Secret | What it is |
|---|---|
| `E2E_HUB_LICENSE` | self-hosted license JWT |
| `GH_E2E_APP_ID` / `GH_E2E_APP_PK` | the org's GitHub App; must be installed on `radar-hub` and `radar-hub-web` with contents read |

There is deliberately no admin-password secret: `run.sh` generates a throwaway
credential per run, because Playwright traces record the login form being filled.

The distribution suite needs no secrets at all - everything it touches is public.

## Notes

- The chart pins pods to `kubernetes.io/arch: amd64`. The harness rewrites that
  selector to the architecture of the kind node, so it works unchanged on Apple
  Silicon.
- Playwright retries are off. A scheduled suite that passes on the second attempt
  hides the flakiness it exists to catch.
- The suite signs in once and shares the session. The hub allows 5 break-glass logins per
  minute per IP, so a login per test starts returning 429 as the suite grows.
- Radar refuses a plain `ws://` tunnel to a non-loopback host, so the harness enables the
  chart's self-signed TLS listener and dials `wss://` with verification skipped - the
  documented trial path. The browser keeps using the plain-http port.
- radar's image must be built with `--target full`; its last stage (`release`) expects
  goreleaser-built binaries in the build context.
- Admin credentials come from `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`; the
  break-glass admin is the only login that works without an identity provider.
- macOS runners cannot run Docker (no nested virtualisation), so the macOS jobs
  test installation and signing only; anything needing a cluster runs on Linux.
