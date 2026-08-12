#!/usr/bin/env bash
# Functional e2e for the PUBLISHED radar CLI (kubectl-radar).
#
# This is the OSS, standalone product - not the hub. No login, no org, no
# fleet, no cluster switching: one binary, pointed at one kubeconfig context,
# serving its own web UI on a local port. Stands up a throwaway kind cluster,
# seeds a couple of small workloads, starts the INSTALLED binary against it
# (no build step - this is meant to test the artifact a user actually runs),
# waits for it to report ready, and drives the UI with Playwright.
#
# Usage:
#   ./run.sh up      # create cluster + seed workloads + start radar
#   ./run.sh test    # run the Playwright specs against the running instance
#   ./run.sh all     # up + test  (default)
#   ./run.sh down    # stop radar and delete the cluster
#   ./run.sh logs    # dump diagnostics (kube-system state, radar's own log)
#
# Optional:
#   RADAR_BIN            path or name of the installed binary (default: kubectl-radar on PATH)
#   RADAR_EXPECTED_VERSION  if set, `up` fails loudly when `$RADAR_BIN --version` disagrees -
#                           the guard against exactly the "Homebrew formula stuck on an old
#                           release and nobody noticed" failure mode this suite exists to catch
#   CLUSTER               kind cluster name (default: dist-e2e)
#   RADAR_PORT             port radar listens on (default: 9280)
#   SPECS                 Playwright filter, e.g. SPECS=timeline. Empty runs all.
#   SCENARIO              label used for the visual/ output subdirectory (default: SPECS or "all")
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

RADAR_BIN="${RADAR_BIN:-kubectl-radar}"
CLUSTER="${CLUSTER:-dist-e2e}"
KUBE_CONTEXT="kind-${CLUSTER}"
RADAR_PORT="${RADAR_PORT:-9280}"
RADAR_URL="http://127.0.0.1:${RADAR_PORT}"
DEMO_NS="${DEMO_NS:-e2e-demo}"
DEMO_DEPLOY="${DEMO_DEPLOY:-demo-probe}"

RUN_DIR="$REPO_ROOT/.run"
KUBECONFIG_FILE="$RUN_DIR/kubeconfig"
RADAR_PID_FILE="$RUN_DIR/radar.pid"
RADAR_LOG_FILE="$RUN_DIR/radar.log"

K="kubectl --kubeconfig $KUBECONFIG_FILE"

say() { printf "\n\033[36m== %s ==\033[0m\n" "$*"; }
die() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

require_binary() {
  if ! command -v "$RADAR_BIN" >/dev/null 2>&1 && [ ! -x "$RADAR_BIN" ]; then
    die "RADAR_BIN=\"$RADAR_BIN\" is not runnable - install kubectl-radar (see the CLI's own README) or pass RADAR_BIN=/path/to/kubectl-radar"
  fi
}

# The whole point of this suite per the shared CONTRACT: assert the INSTALLED
# artifact is the version everyone believes was published, not a stale
# distribution channel (Homebrew formula, install script cache, ...). Opt-in
# via RADAR_EXPECTED_VERSION so this script stays usable standalone against
# whatever a developer has installed locally.
verify_version() {
  [ -n "${RADAR_EXPECTED_VERSION:-}" ] || return 0
  local got
  got="$("$RADAR_BIN" --version 2>&1)" || die "\"$RADAR_BIN --version\" failed: $got"
  # Output is "radar <version>" (e.g. "radar 1.9.2").
  local got_version="${got#radar }"
  if [ "$got_version" != "$RADAR_EXPECTED_VERSION" ]; then
    die "installed $RADAR_BIN reports version \"$got_version\", expected \"$RADAR_EXPECTED_VERSION\". \
The distribution channel that produced this binary is stale - check the install script / Homebrew \
formula / release asset this job downloaded from, and republish or fix the tap before trusting this artifact."
  fi
  say "verified: $RADAR_BIN reports version $got_version"
}

up() {
  require_binary
  verify_version
  mkdir -p "$RUN_DIR"

  say "create kind cluster '$CLUSTER'"
  kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s
  kind get kubeconfig --name "$CLUSTER" > "$KUBECONFIG_FILE"

  # A kind control-plane sharing its Docker VM's CPU with other clusters can
  # crash-loop kube-controller-manager/kube-scheduler out of leader election
  # for the first minute or so after creation (observed while developing this
  # suite) - wait for a stable control plane before seeding anything, rather
  # than let that show up later as a flaky, hard-to-diagnose test failure.
  say "wait for the control plane to stabilize"
  local tries=0
  while true; do
    local cm sc
    cm="$($K -n kube-system get pods -l component=kube-controller-manager -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || echo false)"
    sc="$($K -n kube-system get pods -l component=kube-scheduler -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || echo false)"
    [ "$cm" = "true" ] && [ "$sc" = "true" ] && break
    tries=$((tries + 1))
    [ "$tries" -ge 40 ] && die "kube-controller-manager/kube-scheduler never stabilized after 2m - the kind cluster itself is unhealthy, not radar"
    sleep 3
  done

  seed_workload
  start_radar
}

# A workload for the timeline spec to change, seeded before radar starts so
# the spec's own scale-up is provably the change that reaches the timeline.
# The other specs (resources, topology, logs, diagnose) each seed and clean
# up their own dedicated namespace/deployment - see tests/*.spec.ts.
seed_workload() {
  say "seed demo workload ${DEMO_NS}/${DEMO_DEPLOY}"
  $K create namespace "$DEMO_NS" --dry-run=client -o yaml | $K apply -f - >/dev/null
  $K -n "$DEMO_NS" create deployment "$DEMO_DEPLOY" --image=registry.k8s.io/pause:3.9 --replicas=2 \
    --dry-run=client -o yaml | $K apply -f - >/dev/null
  $K -n "$DEMO_NS" rollout status "deploy/$DEMO_DEPLOY" --timeout=120s
}

start_radar() {
  stop_radar
  say "start $RADAR_BIN --port $RADAR_PORT --no-browser --listen-address 127.0.0.1"
  # Nothing else on this machine should share the port; a leftover process
  # from a previous crashed run is the only realistic collision, and
  # stop_radar above already handles that.
  KUBECONFIG="$KUBECONFIG_FILE" nohup "$RADAR_BIN" \
    --port "$RADAR_PORT" \
    --no-browser \
    --listen-address 127.0.0.1 \
    --kubeconfig "$KUBECONFIG_FILE" \
    > "$RADAR_LOG_FILE" 2>&1 &
  echo $! > "$RADAR_PID_FILE"

  say "wait for $RADAR_URL/api/health to report healthy"
  local tries=0
  while true; do
    local body
    body="$(curl -sf "$RADAR_URL/api/health" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"status":"healthy"'; then
      echo "  healthy after $((tries * 2))s"
      return 0
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      say "radar's own log ($RADAR_LOG_FILE):"
      tail -n 60 "$RADAR_LOG_FILE" || true
      die "radar never reported healthy at $RADAR_URL/api/health within 2m - see the log above"
    fi
    sleep 2
  done
}

stop_radar() {
  [ -f "$RADAR_PID_FILE" ] || return 0
  local pid
  pid="$(cat "$RADAR_PID_FILE")"
  kill "$pid" 2>/dev/null || true
  rm -f "$RADAR_PID_FILE"
}

run_tests() {
  curl -sf "$RADAR_URL/api/health" >/dev/null 2>&1 || die "radar is not running at $RADAR_URL - run './run.sh up' first"
  say "playwright"
  cd "$REPO_ROOT"
  [ -d node_modules ] || npm ci --no-audit --no-fund
  # --with-deps installs the system libraries Chromium needs; it is a no-op
  # on macOS and needs sudo on Linux, so fall back to the browser-only install.
  npx playwright install --with-deps chromium >/dev/null 2>&1 || npx playwright install chromium

  local visual_dir="$REPO_ROOT/visual/${SCENARIO:-${SPECS:-all}}"
  rm -rf "$visual_dir"; mkdir -p "$visual_dir"

  # shellcheck disable=SC2086 - SPECS is a deliberate word-split filter list.
  VISUAL_DIR="$visual_dir" RADAR_URL="$RADAR_URL" \
    RADAR_KUBECONFIG="$KUBECONFIG_FILE" KUBE_CONTEXT="$KUBE_CONTEXT" \
    npx playwright test ${SPECS:-}
  cd "$REPO_ROOT"
}

dump_diagnostics() {
  say "diagnostics"
  echo "-- kube-system pods --"
  $K -n kube-system get pods -o wide || true
  echo "-- radar log (last 200 lines) --"
  tail -n 200 "$RADAR_LOG_FILE" 2>/dev/null || echo "(no log at $RADAR_LOG_FILE)"
}

down() {
  stop_radar
  kind delete cluster --name "$CLUSTER" || true
}

case "${1:-all}" in
  up)    up ;;
  test)  run_tests ;;
  all)   up; run_tests ;;
  down)  down ;;
  logs)  dump_diagnostics ;;
  *) echo "usage: $0 {up|test|all|down|logs}"; exit 2 ;;
esac
