#!/usr/bin/env bash
# Browser e2e for the radar + radar-hub integration.
#
# Stands up a throwaway kind cluster, installs the self-hosted hub from the
# helm-charts source tree using images built from the CURRENT main of each
# repo, and drives the web UI with Playwright. Same script runs on a laptop
# and on a CI runner - CI only differs in where the repos under test are
# checked out (see *_DIR below).
#
# Usage:
#   ./run.sh up      # build images + create cluster + install hub + connect radar
#   ./run.sh test    # run the Playwright specs against a running stack
#   ./run.sh all     # up + test  (default)
#   ./run.sh down    # delete the cluster and stop the port-forward
#
# Required:
#   RADAR_HUB_LICENSE   self-hosted license JWT. Without it the web UI is
#                       gated on a license-required screen and nothing else
#                       can be tested.
#
# Optional (defaults assume sibling checkouts next to this repo):
#   HUB_DIR=../radar-hub   HUB_WEB_DIR=../radar-hub-web
#   CHARTS_DIR=../helm-charts   RADAR_DIR=../radar
#   CLUSTER=radar-e2e   NS=radar-hub   HUB_PORT=18080
#   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
#   SPECS               Playwright filter, e.g. SPECS=timeline. Empty runs all.
#                       CI gives each scenario its own job, cluster and port.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
DIR="."

HUB_DIR="${HUB_DIR:-../radar-hub}"
HUB_WEB_DIR="${HUB_WEB_DIR:-../radar-hub-web}"
CHARTS_DIR="${CHARTS_DIR:-../helm-charts}"
RADAR_DIR="${RADAR_DIR:-../radar}"
# main      = build the three images from the repos under test and install the
#             chart from the helm-charts working tree. Answers "does our code
#             work?".
# published = install the RELEASED chart from the public helm repo with its own
#             default image tags, building nothing. Answers "does the product
#             we shipped work?".
# Running both against the same scenarios is what makes a red scenario
# interpretable: main red + published green is a regression we have not shipped
# yet; both red is already in customers' hands.
VARIANT="${VARIANT:-main}"
HELM_REPO_URL="${HELM_REPO_URL:-https://skyhook-io.github.io/helm-charts}"
CLUSTER="${CLUSTER:-radar-e2e}"
NS="${NS:-radar-hub}"
RADAR_NS="${RADAR_NS:-radar}"
DEMO_NS="${DEMO_NS:-e2e-demo}"
DEMO_DEPLOY="${DEMO_DEPLOY:-timeline-probe}"
FIXTURE_NS="${FIXTURE_NS:-e2e-fixtures}"
CLUSTER_DISPLAY_NAME="${CLUSTER_DISPLAY_NAME:-e2e-kind}"
HUB_PORT="${HUB_PORT:-18080}"
HUB_URL="http://localhost:${HUB_PORT}"
KUBE_CONTEXT="kind-${CLUSTER}"
K="kubectl --context ${KUBE_CONTEXT}"
PF_PID_FILE="$DIR/.run/port-forward.pid"
CLUSTER_ID_FILE="$DIR/.run/cluster-id"

E2E_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-e2e-admin@skyhook.io}"
ADMIN_PASSWORD_FILE="$DIR/.run/admin-password"

# The admin password is generated per run rather than supplied as a CI secret.
# Playwright traces and videos record the login form being filled, so a shared
# secret would end up inside artifacts on every failure; a throwaway credential
# for a throwaway cluster cannot leak anything that outlives the run. `up`
# writes it, `test` reads it back.
resolve_admin_password() {
  if [ -n "${E2E_ADMIN_PASSWORD:-}" ]; then return 0; fi
  if [ -s "$ADMIN_PASSWORD_FILE" ]; then
    E2E_ADMIN_PASSWORD="$(cat "$ADMIN_PASSWORD_FILE")"
  else
    mkdir -p "$DIR/.run"
    E2E_ADMIN_PASSWORD="e2e-$(openssl rand -hex 16)"
    printf '%s' "$E2E_ADMIN_PASSWORD" > "$ADMIN_PASSWORD_FILE"
    chmod 600 "$ADMIN_PASSWORD_FILE"
  fi
}

# helm, retried. In the published variant the chart is fetched from GitHub
# releases at install time, and that download has timed out three times today
# ("context deadline exceeded" pulling radar-hub-1.4.0.tgz), taking whole
# scenario jobs down for a reason that has nothing to do with the product.
# Only the network step is worth retrying; a genuine chart or values error
# fails the same way every attempt and still surfaces after the last one.
helm_retry() {
  local attempt
  for attempt in 1 2 3 4; do
    if helm "$@"; then return 0; fi
    if [ "$attempt" -lt 4 ]; then
      echo "  helm failed (attempt ${attempt}/4), retrying in $((attempt * 10))s" >&2
      sleep $((attempt * 10))
    fi
  done
  return 1
}

say() { printf "\n\033[36m== %s ==\033[0m\n" "$*"; }
die() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

require_license() {
  [ -n "${RADAR_HUB_LICENSE:-}" ] || die "RADAR_HUB_LICENSE is not set - the hub UI would show the license-required screen."
}

build_images() {
  if [ "$VARIANT" = "published" ]; then
    say "variant=published - building nothing, the released images are pulled from the registry"
    return 0
  fi
  # CI builds the three images with cache-aware actions and sets SKIP_BUILD=1.
  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    say "skipping image build (SKIP_BUILD=1) - expecting radar-hub:e2e, radar-hub-web:e2e, radar:e2e"
    return 0
  fi
  say "build hub + web + radar images from source"
  [ -d "$HUB_DIR" ] || die "hub repo not found at $HUB_DIR (set HUB_DIR)"
  [ -d "$HUB_WEB_DIR" ] || die "web repo not found at $HUB_WEB_DIR (set HUB_WEB_DIR)"
  [ -d "$RADAR_DIR" ] || die "radar repo not found at $RADAR_DIR (set RADAR_DIR)"
  docker build -q -t radar-hub:e2e "$HUB_DIR" >/dev/null
  docker build -q -t radar-hub-web:e2e "$HUB_WEB_DIR" >/dev/null
  # --target full is required: radar's last stage is `release`, which expects
  # goreleaser-built binaries in the context, so a bare `docker build` fails.
  docker build -q --target full -t radar:e2e "$RADAR_DIR" >/dev/null
}

up() {
  require_license
  resolve_admin_password
  [ -d "$CHARTS_DIR/charts/radar-hub" ] || die "chart not found at $CHARTS_DIR/charts/radar-hub (set CHARTS_DIR)"
  mkdir -p "$DIR/.run"

  build_images

  say "create kind cluster '$CLUSTER'"
  kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s
  if [ "$VARIANT" != "published" ]; then
    kind load docker-image radar-hub:e2e radar-hub-web:e2e radar:e2e --name "$CLUSTER"
  fi

  # The chart pins pods to amd64 nodes. A kind node inherits the host
  # architecture, so on Apple Silicon that selector leaves every pod Pending.
  # Pin to whatever this node actually is instead of clearing the selector.
  local arch
  arch="$($K get node -o jsonpath='{.items[0].metadata.labels.kubernetes\.io/arch}')"

  # In published mode the chart's OWN image defaults are what we want: they are
  # the officially released hub/web pairing. Overriding them would test a
  # combination nobody ships.
  local image_values=""
  if [ "$VARIANT" != "published" ]; then
    image_values="image:
  hub:
    repository: radar-hub
    tag: e2e
    pullPolicy: IfNotPresent
  web:
    repository: radar-hub-web
    tag: e2e
    pullPolicy: IfNotPresent"
  fi

  say "install radar-hub chart (variant=$VARIANT, arch=$arch)"
  cat > "$DIR/.run/values.yaml" <<EOF
${image_values}
license:
  key: ${RADAR_HUB_LICENSE}
postgres:
  bundled:
    enabled: true
    persistence:
      size: 1Gi
hub:
  publicURL: ${HUB_URL}
  cookiePassword: $(openssl rand -base64 48 | tr -d '\n')
  replicas: 1
  nodeSelector:
    kubernetes.io/os: linux
    kubernetes.io/arch: ${arch}
web:
  nodeSelector:
    kubernetes.io/os: linux
    kubernetes.io/arch: ${arch}
  # Radar refuses a plain ws:// tunnel to anything but a loopback host, and the
  # in-cluster Service name is not loopback. The chart's self-signed listener is
  # the documented trial path for exactly this; radar dials it with
  # cloud.insecureSkipVerify. The browser keeps using the plain-http port.
  tls:
    selfSigned: true
auth:
  breakGlass:
    email: ${E2E_ADMIN_EMAIL}
    password: ${E2E_ADMIN_PASSWORD}
service:
  web:
    type: ClusterIP
EOF
  local hub_chart="$CHARTS_DIR/charts/radar-hub"
  if [ "$VARIANT" = "published" ]; then
    helm repo add skyhook "$HELM_REPO_URL" >/dev/null 2>&1 || true
    helm repo update skyhook >/dev/null
    hub_chart="skyhook/radar-hub"
  fi

  helm_retry upgrade --install radar-hub "$hub_chart" \
    --kube-context "kind-${CLUSTER}" \
    --namespace "$NS" --create-namespace \
    -f "$DIR/.run/values.yaml" --wait --timeout 10m

  $K -n "$NS" rollout status deploy/radar-hub-hub --timeout=300s
  $K -n "$NS" rollout status deploy/radar-hub-web --timeout=300s
  port_forward
  seed_workload
  connect_cluster
}

# A workload for the timeline specs to change. Created before radar connects;
# the specs make the change themselves so the event is provably theirs.
seed_workload() {
  say "seed demo workload ${DEMO_NS}/${DEMO_DEPLOY}"
  $K create namespace "$DEMO_NS" --dry-run=client -o yaml | $K apply -f - >/dev/null
  $K -n "$DEMO_NS" create deployment "$DEMO_DEPLOY" --image=registry.k8s.io/pause:3.9 --replicas=2 \
    --dry-run=client -o yaml | $K apply -f - >/dev/null
  $K -n "$DEMO_NS" rollout status "deploy/$DEMO_DEPLOY" --timeout=120s

  # The wider fixture: several controller kinds, config and secrets, and three
  # deliberately broken workloads. Standing a cluster up costs minutes; giving
  # the specs only one healthy Deployment to look at wastes most of that, and
  # leaves every problem-surfacing page tested in its empty state only.
  say "seed cluster fixtures (${FIXTURE_NS})"
  $K apply -f "$DIR/fixtures/cluster.yaml" >/dev/null

  # Wait only on what can actually become ready. broken-image and
  # unschedulable are MEANT to stay broken - waiting on them would hang the
  # harness for the exact reason the fixture exists.
  $K -n "$FIXTURE_NS" rollout status deploy/storefront --timeout=180s
  $K -n "$FIXTURE_NS" rollout status deploy/chatty --timeout=180s

  # And confirm the broken ones really are broken before any spec asserts on
  # them: a fixture that quietly started working would turn "the product failed
  # to report a problem" into a passing test.
  local phase=""
  for _ in $(seq 1 40); do
    phase="$($K -n "$FIXTURE_NS" get pods -l app=broken-image \
      -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null || true)"
    case "$phase" in *ImagePull*|*ErrImage*) break ;; esac
    sleep 3
  done
  case "$phase" in
    *ImagePull*|*ErrImage*) echo "  broken-image is failing as intended ($phase)" ;;
    *) echo "  WARNING: broken-image never reached an image-pull failure (state: ${phase:-unknown});" \
            "specs that assert on a live problem may report a false all-clear" >&2 ;;
  esac
}

hub_api() {
  # $1=method $2=path; body on stdin when given. X-Hub-Auth satisfies the CSRF
  # guard for non-browser callers (the browser uses Origin instead).
  local method="$1" path="$2"
  curl -sS -b "$DIR/.run/cookies.txt" -c "$DIR/.run/cookies.txt" \
    -H 'Content-Type: application/json' -H 'X-Hub-Auth: 1' \
    -X "$method" "${HUB_URL}${path}" "${@:3}"
}

connect_cluster() {
  say "register cluster '$CLUSTER_DISPLAY_NAME' and install radar"
  rm -f "$DIR/.run/cookies.txt"
  hub_api POST /api/auth/break-glass/login \
    -d "{\"email\":\"${E2E_ADMIN_EMAIL}\",\"password\":\"${E2E_ADMIN_PASSWORD}\"}" >/dev/null

  local existing cluster_id token
  existing="$(hub_api GET /api/clusters | jq -r ".[]? | select(.name==\"$CLUSTER_DISPLAY_NAME\") | .id" | head -1)"
  if [ -n "$existing" ]; then
    cluster_id="$existing"
    token="$(hub_api POST "/api/clusters/$cluster_id/rotate-token" | jq -r '.token')"
  else
    local created
    created="$(hub_api POST /api/clusters -d "{\"name\":\"$CLUSTER_DISPLAY_NAME\"}")"
    cluster_id="$(echo "$created" | jq -r '.cluster.id // .id')"
    token="$(echo "$created" | jq -r '.token')"
  fi
  [ -n "$cluster_id" ] && [ "$token" != "null" ] || die "failed to register a cluster with the hub"
  echo "$cluster_id" > "$CLUSTER_ID_FILE"

  local radar_chart="$RADAR_DIR/deploy/helm/radar"
  local radar_image_args=(--set image.repository=radar --set image.tag=e2e)
  if [ "$VARIANT" = "published" ]; then
    helm repo add skyhook "$HELM_REPO_URL" >/dev/null 2>&1 || true
    helm repo update skyhook >/dev/null
    radar_chart="skyhook/radar"
    # Released chart, released image tag - exactly what `helm install` gives a
    # customer today.
    radar_image_args=()
  fi

  helm_retry upgrade --install radar "$radar_chart" \
    --kube-context "$KUBE_CONTEXT" \
    --namespace "$RADAR_NS" --create-namespace \
    "${radar_image_args[@]}" \
    --set cloud.enabled=true \
    --set "cloud.url=wss://radar-hub-web.${NS}.svc.cluster.local/agent" \
    --set "cloud.clusterName=${CLUSTER_DISPLAY_NAME}" \
    --set "cloud.token=${token}" \
    --set cloud.insecureSkipVerify=true \
    --wait --timeout 10m >/dev/null
  $K -n "$RADAR_NS" rollout status deploy/radar --timeout=300s

  say "wait for the tunnel to report connected"
  local status=""
  for _ in $(seq 1 40); do
    status="$(hub_api GET /api/clusters | jq -r ".[]? | select(.id==\"$cluster_id\") | .status")"
    [ "$status" = "connected" ] && { echo "  cluster $cluster_id is connected"; return 0; }
    sleep 3
  done
  die "cluster never reached connected (last status: ${status:-unknown})"
}

port_forward() {
  stop_port_forward
  say "port-forward $HUB_URL -> web service"
  # Supervised: kubectl port-forward gives up on its own (pod churn, idle
  # resets). Unattended, a dead forward turns every later spec into a
  # connection error that looks like a product failure.
  ( while true; do
      $K -n "$NS" port-forward svc/radar-hub-web "${HUB_PORT}:80" >>"$DIR/.run/port-forward.log" 2>&1
      echo "port-forward exited, restarting" >>"$DIR/.run/port-forward.log"
      sleep 1
    done ) &
  echo $! > "$PF_PID_FILE"
  for _ in $(seq 1 30); do
    curl -sf "$HUB_URL" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "hub web not reachable at $HUB_URL - see $DIR/.run/port-forward.log"
}

stop_port_forward() {
  [ -f "$PF_PID_FILE" ] || return 0
  # Kill the supervisor's process group so the kubectl child goes with it.
  kill -- "-$(cat "$PF_PID_FILE")" 2>/dev/null || kill "$(cat "$PF_PID_FILE")" 2>/dev/null || true
  pkill -f "port-forward svc/radar-hub-web ${HUB_PORT}:80" 2>/dev/null || true
  rm -f "$PF_PID_FILE"
}

run_tests() {
  resolve_admin_password
  curl -sf "$HUB_URL" >/dev/null 2>&1 || port_forward
  say "playwright"
  cd "$DIR"
  [ -d node_modules ] || npm ci --no-audit --no-fund
  # --with-deps installs the system libraries Chromium needs; it is a no-op on
  # macOS and needs sudo on Linux, so fall back to the browser-only install.
  npx playwright install --with-deps chromium >/dev/null 2>&1 || npx playwright install chromium
  # Screenshots land in visual/<scenario>/ so the gallery can group them by
  # scenario and pair each surface against the other variant's copy.
  # In CI SCENARIO is a single name, but locally SPECS is often several specs at
  # once ("smoke helm"), and a directory with a space in it survives here only to
  # break the artifact upload and the gallery's path parsing later.
  local visual_name="${SCENARIO:-${SPECS:-all}}"
  visual_name="$(printf '%s' "$visual_name" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//')"
  local visual_dir="$REPO_ROOT/visual/${visual_name:-all}"
  rm -rf "$visual_dir"; mkdir -p "$visual_dir"

  # shellcheck disable=SC2086 - SPECS is a deliberate word-split filter list.
  VISUAL_DIR="$visual_dir" VARIANT="$VARIANT" \
  HUB_URL="$HUB_URL" \
    E2E_ADMIN_EMAIL="$E2E_ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
    CLUSTER_ID="$(cat "$REPO_ROOT/$CLUSTER_ID_FILE" 2>/dev/null)" \
    KUBE_CONTEXT="$KUBE_CONTEXT" DEMO_NS="$DEMO_NS" DEMO_DEPLOY="$DEMO_DEPLOY" \
    NS="$NS" RADAR_NS="$RADAR_NS" RADAR_DIR="$RADAR_DIR" HELM_REPO_URL="$HELM_REPO_URL" \
    FIXTURE_NS="$FIXTURE_NS" PW_WORKERS="${PW_WORKERS:-1}" \
    npx playwright test ${SPECS:-}
  cd "$REPO_ROOT"
}

dump_diagnostics() {
  say "diagnostics"

  # Pods first, across every namespace this harness puts something in, so a
  # crashlooping component is visible before the logs are read.
  for ns in "$NS" "$RADAR_NS" "$FIXTURE_NS"; do
    echo "--- pods in ${ns}"
    $K -n "$ns" get pods -o wide 2>&1 || true
  done

  echo "--- anything not Running or Completed"
  $K get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded -o wide 2>&1 || true

  # Enough log to see a worker loop, not just the last few lines. --previous
  # too: when a pod restarted, the log that explains why is the one before.
  for target in "deploy/radar-hub-hub" "deploy/radar-hub-web" "statefulset/radar-hub-postgres"; do
    echo "--- ${NS} ${target} (last 400)"
    $K -n "$NS" logs "$target" --tail=400 2>&1 || true
    echo "--- ${NS} ${target} previous container, if it restarted"
    $K -n "$NS" logs "$target" --tail=200 --previous 2>&1 || true
  done

  echo "--- ${RADAR_NS} radar agent (last 300)"
  $K -n "$RADAR_NS" logs deploy/radar --tail=300 2>&1 || true

  echo "--- recent cluster events"
  $K get events -A --sort-by=.lastTimestamp 2>&1 | tail -60 || true

  # The hub's own view of itself. This is what tells a rule that never fired
  # apart from an alert that fired and was never delivered - the two look
  # identical from the outside, and neither is visible in a pod log alone.
  dump_hub_state
}

# Authenticated GETs against the running hub, dumped as JSON.
dump_hub_state() {
  local jar="$DIR/.run/diag-cookies.txt"
  rm -f "$jar"

  if ! curl -sf -c "$jar" -X POST "$HUB_URL/api/auth/login" \
      -H "content-type: application/json" \
      -d "{\"email\":\"${E2E_ADMIN_EMAIL:-}\",\"password\":\"${E2E_ADMIN_PASSWORD:-}\"}" >/dev/null 2>&1; then
    echo "--- hub API state: could not sign in, skipping"
    return 0
  fi

  local org
  org="$(curl -sf -b "$jar" "$HUB_URL/api/orgs" 2>/dev/null \
    | sed -n 's/.*"id":"\(org_[a-z0-9]*\)".*/\1/p' | head -1)"

  for path in \
    "/api/clusters" \
    "/api/fleet/issues" \
    "${org:+/api/orgs/$org/alerts/rules}" \
    "${org:+/api/orgs/$org/alerts/instances?status=open}" \
    "${org:+/api/orgs/$org/inbox}" \
    "/api/triage"
  do
    [ -n "$path" ] || continue
    echo "--- GET ${path}"
    curl -sf -b "$jar" "$HUB_URL$path" 2>&1 | head -c 4000 || true
    echo
  done
  rm -f "$jar"
}

down() {
  stop_port_forward
  kind delete cluster --name "$CLUSTER"
}

case "${1:-all}" in
  up)    up ;;
  test)  run_tests ;;
  all)   up; run_tests ;;
  down)  down ;;
  logs)  dump_diagnostics ;;
  *) echo "usage: $0 {up|test|all|down|logs}"; exit 2 ;;
esac
