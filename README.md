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

Each scenario runs as its own CI job with its own cluster, so they finish in the
time of the slowest rather than the sum, and a wedged cluster cannot take the
others down. Locally, `SPECS=timeline ./run.sh test` runs one of them.

22 scenarios, roughly 55 tests:

| Scenario | What it proves |
|---|---|
| `smoke` | break-glass admin reaches the authenticated app shell, and the org the hub seeds from the license claim exists |
| `timeline` | a workload change made with kubectl reaches both the hub's timeline endpoint and the timeline page |
| `helm` / `helm-actions` | releases the harness installed are listed with chart version and status, and the write actions behave |
| `resources` / `cluster-views` | workload browsing, and the cluster-scoped views radar serves through the tunnel |
| `logs` / `exec` | log streaming and an interactive pod terminal, both proxied end to end |
| `issues` / `alerts` / `diagnose` | problem detection surfaces real cluster state rather than an empty all-clear |
| `certs-checks` | certificate and upgrade-impact checks read live cluster facts |
| `applications-packages` / `gitops` | application and chart inventory, including CRD-backed GitOps resources |
| `multi-cluster` | a second cluster connects and the fleet aggregates across both |
| `cluster-lifecycle` | an agent that stops is reported disconnected rather than stale-connected, comes back on its own, and a rotated token drops the live tunnel and stops working |
| `onboarding` | the install wizard names this hub's real agent URL and mints a token the hub accepts |
| `org-admin` / `settings` | org administration and settings pages |
| `write-actions` | mutating actions are gated and applied correctly |
| `mcp` | the MCP surface answers over the tunnel |
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

Every test also records its whole session to video, embedded in the same page
under the scenario it belongs to and paired across variants like the
screenshots, with a download link on each. The screenshots say what a surface
looked like; the recording says how it got there. They load lazily, so nothing is
fetched until you press play.

Recordings are made at 854px wide, the smallest size where the product's body
text stays readable, and the gallery job re-encodes them to 8fps - Playwright
records at a fixed 25fps and offers no way to change it, which is far more than
a UI walkthrough needs. Together that is roughly an eight-fold reduction,
measured rather than assumed, and the console line and page header both report
the before and after. Without ffmpeg on PATH the recordings still ship, just
uncompressed.

Recording is on by default in CI and only on failure locally. Override with
`E2E_VIDEO=on|retain-on-failure|off`.

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
