# Known issues

Product defects this suite has confirmed and now pins with a test.

The convention: write the test as if the product worked, then mark it
`test.fail()`. Playwright runs it, requires it to fail, and **turns the run red
the moment it starts passing** - which is the signal to delete the marker and
the entry here. A skipped test would rot silently; this one tells you when the
bug is fixed.

Do not add an entry from a hunch. Each one needs a reproduction someone else
can follow.

---

## 1. Fleet views inherit a single cluster's namespace pick

**Confirmed** 2026-08-12. Test: `tests/known-issues.spec.ts`.

Narrowing the namespace switcher in any single-cluster view silently scopes the
**fleet-wide** pages to that namespace, across every cluster. Nothing in the
fleet UI indicates a filter is applied, so the product's core "what is broken
right now" surface can report an all-clear while a critical issue is live in
another namespace.

Affected surfaces (all four verified in source; Issues and Search additionally
reproduced end-to-end):

| Fleet surface | Upstream call | Sends a namespace or `globalNs`? |
|---|---|---|
| Issues | `/api/issues` | no |
| Search | `/api/search` | no |
| Applications | `/api/applications` | no |
| Packages | `/api/packages` | no |

Every one of those radar handlers resolves its namespace list through
`parseNamespacesForUser`, which falls back to the saved pick. So this is not an
Issues bug - it is every fleet aggregation.

Reproduction (needs a >5s gap - the fleet fan-out caches responses for 5s, and
without the gap it looks like there is no bug):

```bash
# a broken workload in some namespace, detected fleet-wide in ~1s
kubectl -n other-ns create deployment broken --image=registry.invalid.example/nope:v1

curl -b jar -X POST -H 'X-Hub-Auth: 1' -H 'Content-Type: application/json' \
  "$HUB/c/$CLUSTER_ID/api/cluster/namespace" -d '{"namespaces":["some-other-namespace"]}'
sleep 12
curl -b jar "$HUB/api/fleet/issues"            # 0 issues, fleet-wide
curl -b jar "$HUB/api/fleet/search?q=broken"   # 0 hits

curl -b jar -X POST -H 'X-Hub-Auth: 1' -H 'Content-Type: application/json' \
  "$HUB/c/$CLUSTER_ID/api/cluster/namespace" -d '{"namespaces":[]}'
sleep 12
curl -b jar "$HUB/api/fleet/issues"            # the issue is back
```

Mechanism:

- radar's `parseNamespacesForUser` (`internal/server/server.go`) falls back to
  the caller's saved namespace-switcher pick when a request carries no explicit
  namespace, and scopes the read to it. The issues handler uses that fallback.
- radar's search handler accepts `globalNs=1` to bypass exactly this - its own
  comment says the omnibar sets it "so a deliberately broad lookup isn't
  silently narrowed".
- radar-hub's fleet fan-out (`internal/server/fleet_handlers.go`) sends neither
  a namespace nor `globalNs`, so every fleet read inherits the pick.

A per-cluster view honouring the pick is intended. A fleet view inheriting one
cluster's cosmetic filter is not.

---

# Observations (not pinned with a test)

Things confirmed while writing the suite that are not functional defects, so
they get no `test.fail()` - but someone should know.

## The workload delete button has no accessible name

The delete control on both the Deployment and Pod drawers is icon-only with no
`aria-label`, `title`, or text (verified by dumping every button's accessible
name in the drawer). It works and is correctly RBAC-gated, so nothing is
broken - but a screen-reader user cannot tell what it does, and `tests/
write-actions.spec.ts` has to target it by its icon class, which is a selector
that will break on any icon-library change. Giving it a name fixes both.

## CRDs installed after radar starts are not picked up until it restarts

radar runs CRD discovery once, in a background goroutine during startup
(`internal/k8s/subsystems.go` calls `DiscoverAllCRDs()` there and nowhere
else). There is no periodic rediscovery and no watch-driven path that starts
tracking a newly created CRD.

Consequence for a customer: install an operator - Argo CD, Flux, Kyverno -
into a cluster radar is already watching, and its resources stay invisible.
For GitOps that means the page keeps saying no controller was detected.

Evidence: after installing Argo CD's CRDs and syncing an Application (Argo
itself reported `Synced/Healthy`), the hub's `/api/fleet/gitops/counts`
reported nothing for 90s, and radar's log showed CRD discovery running only at
startup, never again. `tests/gitops.spec.ts` therefore restarts radar after
creating the CRDs.

Not pinned with `test.fail()`, and stated with its limit: we did not leave it
running long enough to prove the resources NEVER appear - only that they did
not within ~90s, and that the only discovery call site runs at startup. If
there is a slower refresh path somewhere, this is a delay rather than a
permanent gap; either way an operator install is currently not reflected
promptly.
