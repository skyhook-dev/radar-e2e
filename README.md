# radar-e2e

End-to-end browser tests for the **radar + radar-hub** integration.

Stands up the self-hosted hub on a throwaway kind cluster, connects a real radar
over the tunnel, and drives the web UI with Playwright. Everything is built from
the current `main` of `radar-hub`, `radar-hub-web` and `radar`, so this watches
the integration between the three codebases rather than the released artifacts.

This repo holds only the harness — the code under test is checked out per run. It
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
that `up` starts in the background — kind has no load balancer, and port-forward
behaves the same on a laptop and on a CI runner.

## What it covers

1. **Sign-in** — break-glass admin reaches the authenticated app shell, and the org the hub
   seeds from the license claim exists.
2. **Timeline** — the harness connects a real radar to the hub over the tunnel, then the specs
   change a workload with kubectl and assert the change reaches both the hub's timeline
   endpoint and the timeline page. The specs cause the change themselves; asserting over
   pre-existing events would pass against a stale store.

Not covered: hub-side timeline retention. `HUB_TIMELINE_BACKEND` is never set by the chart
(and there is no `extraEnv`), so retention is off and `/c/{id}/api/timeline/*` delegates to
the in-cluster radar. That is what the shipped chart does, so it is what this tests.

## CI

`.github/workflows/e2e.yml` runs this every 2 hours (and on manual dispatch,
which accepts a ref per repo). It differs from a local run in three ways: images are
built by cache-aware build steps and `SKIP_BUILD=1` tells `run.sh` to skip its own
build; the private `radar-hub-web` checkout uses a GitHub App token minted per job;
and the Playwright report is uploaded on success as well as failure, because its
attachments (matched timeline events, a full-page timeline screenshot) are the only
evidence anyone can look at afterwards.

Repository secrets it needs:

| Secret | What it is |
|---|---|
| `E2E_HUB_LICENSE` | self-hosted license JWT |
| `GH_APP_ID` / `GH_APP_PK` | the org's GitHub App; must be installed on `radar-hub` and `radar-hub-web` with contents read |

There is deliberately no admin-password secret: `run.sh` generates a throwaway
credential per run, because Playwright traces record the login form being filled.

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
