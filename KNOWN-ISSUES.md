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

## 2. `/api/auth/dev-signin` is mounted regardless of the dev-bypass setting

**Confirmed** 2026-08-12. Test: `tests/known-issues.spec.ts`.

The dev-bypass sign-in route is registered unconditionally, although its own
doc comment states it is "Only registered when DevBypass is on". The session it
issues cannot authenticate anything, so this is **not** an authentication
bypass - but the endpoint should not be reachable on a hub that has dev bypass
disabled.

Details, impact assessment and the reproduction are deliberately NOT in this
file: this repository is public and the issue is unfixed. They are recorded in
the internal defect list held with the effort notes, and should move to the
private tracker.

Fix: register the route inside the `DevBypass` conditional, as documented.

---

## 3. Helm write controls are shown as enabled but always fail

**Confirmed** 2026-08-12. Test: `tests/helm-actions.spec.ts`.

Radar gates Helm write operations (Upgrade, Rollback, Uninstall, editing
Values) behind a deliberate, secure-by-default RBAC check: writing a chart
needs broad `create/update/patch/delete` permissions because a chart can
create any resource type, so that grant is opt-in via `rbac.helm=true` on the
Radar chart, off by default. That part is working as designed and is not the
bug.

The bug is that two different code paths answer "can Helm writes happen?"
using two different identities, and only one of them is what the UI shows:

- `handleCapabilities` (`internal/server/server.go`) computes the
  `helmWrite` field the frontend uses to decide whether to render Upgrade /
  Rollback / Edit-Values as enabled. When auth is on it calls
  `k8s.CheckCapabilitiesForUser(user.Username, user.Groups)`, which runs the
  RBAC check **as the impersonated end user**. A cluster-admin (or the
  break-glass admin used by this suite) can create Secrets, so `helmWrite`
  comes back `true`.
- `requireHelmWrite` (`internal/helm/handlers.go`), which every write
  endpoint (`.../values` PUT, upgrade, upgrade-stream, rollback,
  rollback-stream, uninstall) calls before doing anything, instead calls
  plain `k8s.CheckCapabilities(ctx)` - no user argument - which checks
  **Radar's own ServiceAccount**, via its own comment: "if the service
  account can create secrets, it likely has the broad RBAC granted by
  `rbac.helm=true`." That SA only gets `secrets:create` (and the wildcard
  write rule in `deploy/helm/radar/templates/clusterrole.yaml:62`) when the
  chart was installed with `rbac.helm=true`.

So on any Radar install that has not opted into `rbac.helm=true` (the
default), every user - including full cluster admins - sees fully-enabled
Upgrade/Rollback/Edit-Values controls that unconditionally 403 the moment
they are used, with no upfront indication (no disabled state, no banner) that
writes are unavailable. The failure only surfaces after Edit -> Preview ->
Apply, or History -> Rollback -> confirm, several steps into the flow.

Reproduction (against a Radar install without `rbac.helm=true`, as any
authenticated user):

```bash
curl -b jar "$HUB/c/$CLUSTER_ID/api/capabilities" | jq .helmWrite
# true - the frontend renders Upgrade/Rollback/Edit-Values as enabled

curl -b jar -X PUT -H 'Content-Type: application/json' \
  "$HUB/c/$CLUSTER_ID/api/helm/releases/<namespace>/<release>/values" \
  -d '{"values":"message: v2"}'
# HTTP 403
# {"error":"Helm write operations require additional RBAC permissions.
#           Set rbac.helm=true in the Radar Helm chart values."}
```

Also reproduced end-to-end through the UI: editing a release's Values and
clicking Apply, and confirming Rollback from History, both show the same
403 after going through the full flow (screenshots attached by
`tests/helm-actions.spec.ts`), while `/api/capabilities` reported
`helmWrite: true` for the same session throughout.

Fix: `handleCapabilities` should compute `helmWrite` the same way
`requireHelmWrite` enforces it (Radar's own ServiceAccount permissions), not
the calling user's. If a per-user check is also useful, both should be
`&&`-ed together rather than the enforced one being silently stricter than
the one the UI acts on.

---

## 4. The Reachability tab is entirely absent from the Hub UI (frontend pinned two releases behind the backend)

**Confirmed** 2026-08-12. Test: `tests/diagnose.spec.ts`.

Opening any workload's Reachability tab through the Hub -
`/workload/{Kind}/{ns}/{name}?tab=diagnose` (or the current name,
`?tab=reachability`) - silently lands on Overview. No tab, no inline "Verify
the live path" glance, no error: the entire network-reachability feature is
invisible. Reproduced against three purpose-built Services and also against
the pre-existing `kube-system/kube-dns` Service, so it is not
resource-specific - the feature simply is not in the page at all.

The backend is unaffected: `GET /c/{clusterId}/api/trace/{Kind}/{ns}/{name}
?probe=true` on radar, proxied by the Hub exactly as the tab would call it,
works correctly and returns accurate, ground-truth-matching verdicts -
confirmed against three Services with known, deliberately different real
outcomes (a genuinely healthy backend, a Service whose declared port nothing
listens on, and a Service whose selector matches no pods) in
`tests/diagnose.spec.ts`.

Reproduction:

```bash
# the feature's own client code isn't shipped at all
curl -s "$HUB/" | grep -o 'src="[^"]*\.js"'          # -> /assets/index-XXXX.js
curl -s "$HUB/assets/index-XXXX.js" | grep -c isDiagnoseKind   # 0
curl -s "$HUB/assets/index-XXXX.js" | grep -c 'api/trace'      # 0

# yet the backend the tab would call works fine, proxied through the same hub
curl -b jar "$HUB/c/$CLUSTER_ID/api/trace/Service/kube-system/kube-dns?probe=true"
# HTTP 200, full verdict/headline/routes JSON
```

Mechanism: `radar-hub-web/package-lock.json` pins `@skyhook-io/radar-app` to
**1.9.4**. The Reachability feature (`isDiagnoseKind`, the "Reachability" tab,
the `/api/trace` client calls) was added in radar commit `0de3cb6d`
("feat(reachability): Network-path diagnosis", 2026-08-06) and first
published as **`radar-app-v1.9.6`** - two releases after what the Hub
currently has installed. `radar-hub-web/package.json` declares
`^1.9.4` (which would normally resolve to 1.9.7), but the lockfile has not
been regenerated since the dependency bump landed, so the installed/bundled
version stays 1.9.4.

Not a logic bug in either codebase - a dependency version lag between two
repos that release independently. Bumping `@skyhook-io/radar-app` past
`1.9.6` in `radar-hub-web/package.json` and regenerating the lockfile
restores the feature; no code change should be needed in either repo.

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

## Hub probes use a 1-second timeout, so a busy node restarts a healthy hub

`charts/radar-hub` sets `timeoutSeconds: 1` (the Kubernetes default) on the
hub's liveness and readiness probes, with no way to raise it from values.

On a CPU-starved node that is enough to fail: observed the hub's liveness probe
time out repeatedly on a loaded machine and **restart a hub that was serving
fine** - its own log showed a clean boot and `license verified` throughout, and
`pg_isready` on the bundled Postgres was timing out at the same moment. The
deployment never reached Available, so `helm install --wait` hung until it gave
up.

Not filed as a defect: the environment really was starved (five kind clusters
on one Docker VM), and a 1s timeout is Kubernetes' own default. Recorded
because the failure looks like a broken hub rather than a slow node, and
because a customer on a small or busy node - or a CI runner running kind plus
the whole stack plus a browser - can hit the same thing. A couple of seconds of
timeout, or exposing it in values, would remove the trap.

## The desktop `.rpm` cannot be installed on RHEL 9 and its rebuilds

`radar-desktop_<tag>_linux_amd64.rpm` declares a dependency on
`webkit2gtk4.1`. Fedora ships that package; RHEL 9, Rocky 9 and AlmaLinux 9 do
not carry it in their base repositories, so `dnf install ./radar-desktop.rpm`
stops at:

```
nothing provides webkit2gtk4.1 needed by radar-desktop-1.9.2-1.x86_64
```

Reproduced in the `.rpm install (rockylinux:9)` job; the same job passes on
`fedora:40`, which isolates the cause to the distribution's package set rather
than to the `.rpm` being malformed. A user on the most common enterprise Linux
family cannot install the desktop app from the published `.rpm` at all, and the
download page does not mention that EPEL (or an equivalent) is required first.

Pinned in the workflow: the job tolerates exactly this message and warns, and
fails if the install starts failing for any other reason. When the dependency
is satisfiable, the pinned branch stops being taken and the pin should be
removed here and in `.github/workflows/dist-e2e.yml`.

## The published Windows desktop build carries no version resource

`Radar.exe` from `radar-desktop_<tag>_windows_amd64.zip` reports an empty
`ProductVersion` and an empty `FileVersion`:

```
Radar.exe version resource: ProductVersion='' FileVersion=''
```

On Windows that is the field Explorer's Properties dialog, winget and every
software-inventory tool read, so the app shows as unversioned and two different
releases are indistinguishable once extracted. It also removes the only way to
check the version at all for this binary: `Radar.exe` is a GUI-subsystem
executable, so `Radar.exe --version` writes nothing to the console and does not
set an exit code, no matter what the flag does internally.

Pinned in the `Windows / Desktop launch smoke` job, which warns and continues so
the launch smoke still runs. If a version appears but is wrong, that is a hard
failure rather than a pin.

## View state is server-side and outlives the session

Two filters in the hub are stored per user rather than per tab, so setting one
changes what every later page load shows - including other tests, and other
people signed in as the same account:

- the namespace pick (`?namespaces=`), which is defects 1 and 11 in the list and
  the reason `known-issues` runs on its own cluster
- the Open/Snoozed/Dismissed/All selection on Issues and Checks

This is recorded here because it constrains how tests are written rather than
because it is necessarily wrong. It bit the suite for the third time today: the
state-filter test walked every tab and left the selection on the last one, and a
LATER RUN's search test then could not find an issue that was plainly present in
`/api/fleet/issues`. The failure looked like a broken page and was a filter
someone else had set minutes earlier.

The rule that follows: any test touching one of these filters must put it back,
the way `cluster-lifecycle` restores the agent it scaled down. A test that
changes shared state and does not restore it is not isolated, however it is
scheduled.

## Triage records are org state, and the API only accepts same-origin deletes

Mark seen, Snooze and Dismiss all POST to `/api/triage`, and all three are undone
by `DELETE /api/triage/{id}`. The records are per organisation, not per session,
so anything a test leaves behind hides an issue from every later run - the same
class of problem as the view state above, with a sharper edge, because a
dismissed issue disappears from the Open queue entirely.

The trap when cleaning up: that DELETE is rejected with **403 from
`page.request.delete`** and accepted with **204 from a `fetch` inside the page**.
The hub requires the request to come from the app's own origin. An `afterEach`
that used `page.request` and swallowed errors therefore did nothing at all, for
every run, silently - which is worse than having no cleanup, because the next
test starts against a hub that is not in the state it assumes and fails
somewhere unrelated.

Cleanup goes through `page.evaluate(() => fetch(...))`, and asserts the 204.

## The fleet endpoints have a per-user budget, and pages say so out loud

`/api/fleet/*` is limited to roughly 30 requests per minute per user. A run that
walks several domains in a row exhausts it, and the pages then render an explicit
error - "Failed to load checks: Too Many Requests" - **with their controls
absent**. The grouping control disappears from Checks; the search box and every
row disappear from Applications.

A test that asserts on those controls reads this as a missing feature and files a
defect against a product that is behaving correctly and saying so clearly. Use
`gotoWhenNotRateLimited()` from `helpers.ts`, which waits the budget out and
re-checks after a beat - a page can render its shell cleanly and only then have
one of its own fetches come back 429.

## Two Pending pods, one capacity problem

The fixture cluster carries two pods that `kubectl get pods
--field-selector=status.phase=Pending` returns together:

- `unschedulable` - no node assigned, `PodScheduled` reason `Unschedulable`,
  requests 512Gi. This is scheduling demand.
- `broken-image` - already assigned to a node, stuck on `ImagePullBackOff`.

The Capacity page counts the first and not the second, which is correct: the
second one's problem is a registry, not a node. A test that took the field
selector's count as its expected value would report correct behaviour as a bug.

## Alert rules baseline a cluster on their first poll

An alert rule's first poll of a cluster records whatever is already broken
without notifying about it. On a cluster created minutes ago - which is every CI
job - all the fixture issues are baselined, so the notification inbox is
legitimately empty.

Any test that reasons "this cluster has issues, therefore something should have
been notified" fails against a product doing exactly the right thing. Proving a
notification is raised needs a problem created AFTER the baseline, which is what
`journey-broken-workload` does.

## The inbox endpoint returns unread items, one page at a time

`GET /api/orgs/{id}/inbox` returns UNREAD notifications only, capped at 50. Two
consequences for tests:

- anything that marks notifications read empties it for everything after, so a
  "mark all read" test and an "inbox has items" test cannot share a file without
  ordering them deliberately
- the bell's count and the API's length legitimately differ (117 unread against
  a page of 50). Asserting they are equal fails on a correct product.

## "unavailable" on a dashboard card can just mean rate limited

The Checks card renders `Checks - unavailable` when its own request is rejected
by the fleet budget, and nothing else on the page says a 429 happened. A test
that treats that as "the dashboard is under-reporting" reports a working product
as broken; given a fresh load and a recovered budget the card fills in normally.

Only a card that stays unavailable while the page behind it serves data is worth
reporting, because that is the state that would mislead an operator.

## Observed, not filed

Two things this suite records per run rather than asserting, because nothing
here establishes what the product intends. Both are visible in the run's
annotations, and both are questions for whoever owns the feature:

- **The "Workload degraded" drawer carries no NEXT STEP** where the image-pull
  and unschedulable drawers both do. If every issue type is meant to offer
  guidance, this is a gap; if some are informational, it is not.
- ~~A workload broken after the alert baseline raised no notification~~
  **RESOLVED, and it was the test.** The org does have a default rule
  ("Notify on critical issues", enabled, filtering severity=critical, with
  inbox delivery and notify-on-resolve both on). The journey was creating its
  workload before that rule's FIRST poll of the cluster, so the breakage was
  swept into the baseline and correctly never notified. The journey now forces
  the baseline first - a throwaway broken workload, waited on until an alert
  instance proves the poll happened - and the notification then arrives, so it
  is asserted rather than recorded.
