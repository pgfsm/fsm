#!/usr/bin/env bash
# SPEC-007's acceptance suite on kind (#458 part 3, #641): the criteria that
# need a cluster, on the stack smoke.sh deployed (reference manifests, two
# gateway replicas, PgBouncer, test Postgres). Run smoke.sh first with the
# cluster kept (KEEP=1, or SKIP_CLUSTER=1 as CI does), then this.
#
# It swaps each worker Deployment to test-apps/e2e's loadWork worker, shortens
# the gateway's poll interval, and checks:
#
# 1. Throughput scales with replicas: TypeScript at 2 replicas processes
#    ≥ 1.8× the messages per minute of 1 replica under a saturated queue,
#    while Go's (fixed at 1 replica, loaded alongside) stays within ±25 %.
# 2. Connections bounded: at 1 and at 4 TypeScript replicas, Postgres client
#    backends (besides this script's) number at most gateway replicas × pool
#    max, and every one comes from PgBouncer, none from a worker pod.
# 3. Auth: a worker with a wrong token, and one with none, is refused before
#    registering; plaintext to the TLS listener never registers; a token added
#    to the Secret is accepted without restarting the gateway.
# 4. Gateway rolling restart under load loses no messages, and every worker
#    re-registers without its pod restarting.
# 5. Half-open connections: every packet to and from a worker pod is dropped
#    on the node (iptables, so the established connection is cut without a
#    close; a NetworkPolicy only filters new connections). Both sides notice
#    within ~40 s, the in-flight invoke fails as retriable (left for
#    redelivery), and once the path is back the worker reconnects and the
#    message is processed.
#
# Usage (from anywhere in the repository):
#   packages/fsm-async-worker-gateway-ts/deploy/k8s/overlays/kind/acceptance.sh
#
# Environment:
#   CLUSTER     kind cluster name (default: pgfsm-smoke)
#   KIND        kind command (default: kind)
#   SKIP_BUILD  1 = the e2e worker images are already built
#
# Needs deno, jq and docker; the kind node must be a local Docker container
# (the half-open check runs iptables in it).
set -euo pipefail

KIND=${KIND:-kind}
CLUSTER=${CLUSTER:-pgfsm-smoke}
ROOT=$(git rev-parse --show-toplevel)
DOCKER_DIR="$ROOT/packages/fsm-async-worker-gateway-ts/deploy/docker"
E2E="$ROOT/test-apps/e2e"
LOAD="$E2E/tools/load.ts"
LANGS=(typescript python rust go)
NS=pgfsm
NODE="$CLUSTER-control-plane"
# pg.Pool's default max: the gateway CLI doesn't set one. No LISTEN
# connection either: the manifests don't pass --listen-db-url.
GATEWAY_POOL_MAX=10
GATEWAY_REPLICAS=2
# Invokes time out after 50 s, so a claimed message comes back after 51 s:
# longer than the ~40 s half-open detection, which must win.
INVOKE_TIMEOUT_MS=50000
WORK=$(mktemp -d)
RUN=e2e-$(openssl rand -hex 4)
PF_PORT=15432
HARNESS_APP=e2e-harness
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:$PF_PORT/postgres?application_name=$HARNESS_APP"

log() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "FAILED: $*" >&2
  exit 1
}
# Never `cmd | grep -q` (see smoke.sh, #493).

# The script's own stdout, for the diagnostics: a failure inside a command
# whose output is redirected runs the EXIT trap with that redirection.
exec 3>&1

# A worker pod's restarts: why its last container ended, and its output.
container_history() {
  kubectl -n "$NS" get pod "$1" -o jsonpath='{.metadata.name}: restarts {.status.containerStatuses[0].restartCount}, last state {.status.containerStatuses[0].lastState}{"\n"}' || true
  kubectl -n "$NS" logs "$1" --previous --tail=60 2>/dev/null || true
}

pf_pid=""
blackholed=""
cleanup() {
  status=$?
  exec 1>&3
  if [[ -n "$blackholed" ]]; then unblackhole "$blackholed" || true; fi
  if [[ $status -ne 0 ]]; then
    log "FAILED: diagnostics"
    kubectl -n "$NS" get pods -o wide || true
    kubectl -n "$NS" logs -l app.kubernetes.io/name=activity-gateway --tail=150 --prefix || true
    kubectl -n "$NS" logs -l app.kubernetes.io/component=async-worker --tail=40 --prefix || true
    for pod in $(kubectl -n "$NS" get pods -l app.kubernetes.io/component=async-worker -o name 2>/dev/null); do
      [[ "$(kubectl -n "$NS" get "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')" == 0 ]] ||
        container_history "${pod#pod/}"
    done
  fi
  [[ -n "$pf_pid" ]] && kill "$pf_pid" 2>/dev/null || true
  rm -rf "$WORK"
  exit $status
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------

load() { deno run --allow-all --quiet "$LOAD" "$@"; }

# The run's stats for one language, as JSON (load.ts stats --json).
stats_of() {
  load stats --run-id "$1" --language "$2" --json | jq -c '.languages[0]'
}

# Waits until every message of run $1 for languages ${@:3} is done (load.ts's
# --wait), up to $2 seconds, and prints the stats JSON.
drain() {
  local run=$1 wait=$2
  shift 2
  local args=()
  for lang in "$@"; do args+=(--language "$lang"); done
  load stats --run-id "$run" "${args[@]}" --wait "$wait" --json
}

assert_none_lost() {
  jq -e '.languages[] | select(.lost != 0 or .queued != 0 or .succeeded != .sent)' \
    <<<"$1" >/dev/null && fail "messages lost or left queued: $1"
  return 0
}

# Running (not terminating) pods with this app.kubernetes.io/name.
pods_of() {
  kubectl -n "$NS" get pods -l "app.kubernetes.io/name=$1" \
    -o jsonpath='{range .items[*]}{.metadata.deletionTimestamp}|{.metadata.name}{"\n"}{end}' |
    sed -n 's/^|//p'
}

# A worker pod's id: each SDK logs "<lang>-<8 hex>" at start.
worker_id() {
  kubectl -n "$NS" logs "$1" 2>/dev/null | grep -o "$2-[0-9a-f]\{8\}" | head -1 || true
}

# Gateway log lines since $1 (RFC 3339, or empty for all), every current pod.
gateway_logs() {
  local since=()
  [[ -n "${1:-}" ]] && since=(--since-time="$1")
  for pod in $(pods_of activity-gateway); do
    kubectl -n "$NS" logs "$pod" "${since[@]}" 2>/dev/null || true
  done
}

# Waits until every current pod of async-worker-$1 has registered with a
# current gateway pod (since $2, if given), up to 180 s.
wait_registered() {
  local lang=$1 since=${2:-} deadline=$((SECONDS + 180))
  while ((SECONDS < deadline)); do
    local all=1 pods
    pods=$(pods_of "async-worker-$lang")
    [[ -n "$pods" ]] || all=""
    local logs
    logs=$(gateway_logs "$since")
    for pod in $pods; do
      local id
      id=$(worker_id "$pod" "$lang")
      if [[ -z "$id" ]] || ! grep -F "Worker \"$id\" authenticated" <<<"$logs" >/dev/null; then
        all=""
        break
      fi
    done
    if [[ -n "$all" ]]; then
      echo "$lang: $(wc -w <<<"$pods" | tr -d ' ') pod(s) registered"
      return 0
    fi
    sleep 2
  done
  fail "async-worker-$lang: not every pod registered within 180 s"
}

scale_workers() {
  kubectl -n "$NS" scale "deploy/async-worker-$1" --replicas="$2" >/dev/null
  kubectl -n "$NS" rollout status "deploy/async-worker-$1" --timeout=300s >/dev/null
  # Scaling down leaves terminating pods behind for a while; wait them out.
  local deadline=$((SECONDS + 120))
  while (($(kubectl -n "$NS" get pods -l "app.kubernetes.io/name=async-worker-$1" --no-headers | wc -l) != $2)); do
    ((SECONDS < deadline)) || fail "async-worker-$1: not at $2 pods"
    sleep 2
  done
  wait_registered "$1"
}

pg_pod=$(kubectl -n pgfsm-db get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}')
pg_psql() {
  kubectl -n pgfsm-db exec -i "$pg_pod" -- env PGPASSWORD=postgres \
    psql -q -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"
}

# Client backends other than this script's own (the load tool's and this
# psql), as "<count> <comma-separated client addresses>".
activity_backends() {
  pg_psql -F ' ' -c "SELECT count(*), coalesce(string_agg(DISTINCT host(client_addr), ','), '')
      FROM pg_stat_activity
     WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
       AND coalesce(application_name, '') <> '$HARNESS_APP'"
}

# Samples activity_backends every second into $1 until killed.
sample_backends() {
  while true; do
    activity_backends >>"$1" 2>/dev/null || true
    sleep 1
  done
}

# Fails unless every sample in $1 is within the bound and from PgBouncer.
check_backends() {
  local samples=$1 label=$2 bound=$((GATEWAY_REPLICAS * GATEWAY_POOL_MAX))
  local pooler_ips
  pooler_ips=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=pgbouncer \
    -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}')
  [[ -s "$samples" ]] || fail "$label: no pg_stat_activity samples"
  local max
  max=$(awk 'BEGIN { m = 0 } $1 > m { m = $1 } END { print m }' "$samples")
  echo "$label: at most $max activity-tier backends (bound $bound)"
  ((max > 0)) || fail "$label: no activity-tier backend seen"
  ((max <= bound)) || fail "$label: $max backends > $bound"
  local addr
  for addr in $(awk '{ print $2 }' "$samples" | tr ',' '\n' | sort -u); do
    grep -Fx "$addr" <<<"$pooler_ips" >/dev/null ||
      fail "$label: a backend from $addr, not PgBouncer ($pooler_ips)"
  done
}

# Drops every packet to and from a pod IP on the kind node, before conntrack
# (raw table): an established connection goes silent without a FIN or RST.
blackhole() {
  docker exec "$NODE" iptables -t raw -I PREROUTING -s "$1" -j DROP
  docker exec "$NODE" iptables -t raw -I PREROUTING -d "$1" -j DROP
  blackholed=$1
}
unblackhole() {
  docker exec "$NODE" iptables -t raw -D PREROUTING -s "$1" -j DROP
  docker exec "$NODE" iptables -t raw -D PREROUTING -d "$1" -j DROP
  blackholed=""
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Fails if the half-open check's worker pod restarted: it must reconnect in
# place.
assert_not_restarted() {
  if [[ "$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')" != "$restarts" ]]; then
    container_history "$pod" >&2
    fail "the worker pod $pod restarted ($1)"
  fi
}

# Seconds until $2 (a fixed string) appears in the output of command $1...,
# polled every 2 s, up to $3 seconds; fails otherwise.
seconds_until() {
  local pattern=$1 limit=$2 start=$SECONDS
  shift 2
  while ((SECONDS - start <= limit)); do
    if "$@" | grep -F -- "$pattern" >/dev/null; then
      echo $((SECONDS - start))
      return 0
    fi
    sleep 2
  done
  fail "no \"$pattern\" within ${limit}s"
}

# --- setup -------------------------------------------------------------------

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  deno_version=$(sed -n 's/^deno = "\(.*\)"/\1/p' "$ROOT/.prototools")
  log "Building test-apps/e2e worker images"
  for lang in "${LANGS[@]}"; do
    DOCKER_BUILDKIT=1 docker build -q -f "$DOCKER_DIR/worker-$lang.Dockerfile" \
      --build-arg "DENO_VERSION=$deno_version" -t "pgfsm/async-worker-$lang:e2e" \
      "$E2E/async-worker/$lang"
  done
fi
for lang in "${LANGS[@]}"; do
  $KIND load docker-image --name "$CLUSTER" "pgfsm/async-worker-$lang:e2e"
done

log "Gateway: poll every 200 ms, invokes time out after ${INVOKE_TIMEOUT_MS} ms"
kubectl -n "$NS" patch deploy/activity-gateway --type=json -p "[
  {\"op\": \"add\", \"path\": \"/spec/template/spec/containers/0/args/-\", \"value\": \"--poll-interval-ms=200\"},
  {\"op\": \"add\", \"path\": \"/spec/template/spec/containers/0/args/-\", \"value\": \"--invoke-timeout-ms=$INVOKE_TIMEOUT_MS\"},
  {\"op\": \"add\", \"path\": \"/spec/template/spec/containers/0/args/-\", \"value\": \"--vt-margin-seconds=1\"}
]" >/dev/null
kubectl -n "$NS" scale deploy/activity-gateway --replicas="$GATEWAY_REPLICAS" >/dev/null
kubectl -n "$NS" rollout status deploy/activity-gateway --timeout=300s

log "Workers: test-apps/e2e's loadWork, one replica per language"
for lang in "${LANGS[@]}"; do
  kubectl -n "$NS" set image "deploy/async-worker-$lang" "worker=pgfsm/async-worker-$lang:e2e" >/dev/null
  kubectl -n "$NS" scale "deploy/async-worker-$lang" --replicas=1 >/dev/null
done
for lang in "${LANGS[@]}"; do
  kubectl -n "$NS" rollout status "deploy/async-worker-$lang" --timeout=300s >/dev/null
done
for lang in "${LANGS[@]}"; do scale_workers "$lang" 1; done
# Workers have no database settings at all: the gateway is the activity
# tier's only path to Postgres.
for lang in "${LANGS[@]}"; do
  if kubectl -n "$NS" get deploy "async-worker-$lang" -o json |
    jq -e '[.spec.template.spec.containers[].env[]?.name] | any(. == "DATABASE_URL" or startswith("PG") and (startswith("PGFSM_") | not))' >/dev/null; then
    fail "async-worker-$lang has database settings"
  fi
done

kubectl -n pgfsm-db port-forward svc/postgres "$PF_PORT:5432" >"$WORK/port-forward.log" 2>&1 &
pf_pid=$!
for _ in $(seq 1 30); do
  load stats --run-id none --json >/dev/null 2>&1 && break
  sleep 1
done

# --- 1 + 2: throughput and connections ---------------------------------------

# One saturated round: TypeScript and Go loaded together, while sampling
# backends. Prints "<typescript per minute> <go per minute> <ts workers seen>".
round() {
  local run=$1 ts_count=$2 go_count=$3
  load enqueue --language typescript --count "$ts_count" --work-ms 500 --run-id "$run" >/dev/null
  load enqueue --language go --count "$go_count" --work-ms 500 --run-id "$run" >/dev/null
  sample_backends "$WORK/backends-$run" &
  local sampler=$!
  local out
  out=$(drain "$run" 600 typescript go)
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  assert_none_lost "$out"
  jq -r '[(.languages[] | select(.language == "typescript") | .perMinute),
          (.languages[] | select(.language == "go") | .perMinute),
          (.languages[] | select(.language == "typescript") | .byWorker | length)] | @tsv' <<<"$out"
}

log "1. Throughput: TypeScript at 1 replica, Go alongside"
round "$RUN-thr1" 80 80 >"$WORK/round1"
read -r ts1 go1 _ <"$WORK/round1"
echo "typescript ${ts1}/min, go ${go1}/min"
check_backends "$WORK/backends-$RUN-thr1" "1 TypeScript replica"

log "1. Throughput: TypeScript at 2 replicas, Go unchanged"
scale_workers typescript 2
round "$RUN-thr2" 160 80 >"$WORK/round2"
read -r ts2 go2 seen2 <"$WORK/round2"
echo "typescript ${ts2}/min (${seen2} pods), go ${go2}/min"
((seen2 == 2)) || fail "the TypeScript load was processed by $seen2 pod(s), not 2"
awk -v a="$ts1" -v b="$ts2" 'BEGIN { r = b / a; printf "typescript: %.2fx\n", r; exit !(r >= 1.8) }' ||
  fail "TypeScript throughput didn't scale ≥ 1.8x ($ts1 → $ts2 /min)"
awk -v a="$go1" -v b="$go2" 'BEGIN { r = b / a; printf "go: %.2fx\n", r; exit !(r >= 0.75 && r <= 1.25) }' ||
  fail "Go throughput changed ($go1 → $go2 /min)"

log "2. Connections: TypeScript at 4 replicas"
scale_workers typescript 4
round "$RUN-conn4" 160 20 >/dev/null
check_backends "$WORK/backends-$RUN-conn4" "4 TypeScript replicas"
scale_workers typescript 1

# --- 3: auth ------------------------------------------------------------------

# A one-off TypeScript worker pod with its own id and settings ($2...: extra
# env entries as JSON objects), as a Job admitted under "restricted".
worker_job() {
  local name=$1 backoff=$2
  shift 2
  local env
  env=$(printf '%s\n' \
    '{"name": "PGFSM_GATEWAY_CA_FILE", "value": "/etc/pgfsm/ca/ca.crt"}' \
    "{\"name\": \"PGFSM_WORKER_ID\", \"value\": \"$name\"}" "$@" | jq -s -c .)
  kubectl -n "$NS" apply -f - >/dev/null <<EOF
{
  "apiVersion": "batch/v1", "kind": "Job",
  "metadata": {"name": "$name"},
  "spec": {
    "backoffLimit": $backoff, "activeDeadlineSeconds": 300,
    "template": {"spec": {
      "restartPolicy": "Never",
      "securityContext": {"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532,
                          "seccompProfile": {"type": "RuntimeDefault"}},
      "containers": [{
        "name": "worker", "image": "pgfsm/async-worker-typescript:e2e", "imagePullPolicy": "Never",
        "args": ["start"], "env": $env,
        "securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
                            "capabilities": {"drop": ["ALL"]}},
        "volumeMounts": [{"name": "ca", "mountPath": "/etc/pgfsm/ca", "readOnly": true},
                         {"name": "tokens", "mountPath": "/etc/pgfsm/token", "readOnly": true},
                         {"name": "tmp", "mountPath": "/tmp"}]
      }],
      "volumes": [{"name": "ca", "configMap": {"name": "activity-gateway-ca"}},
                  {"name": "tokens", "secret": {"secretName": "e2e-tokens"}},
                  {"name": "tmp", "emptyDir": {}}]
    }}
  }
}
EOF
}

# Waits for Job $1 to fail, then checks it never registered.
expect_refused() {
  kubectl -n "$NS" wait --for=condition=failed "job/$1" --timeout=180s >/dev/null ||
    fail "job $1 didn't fail"
  if gateway_logs | grep -F "Worker \"$1\" authenticated" >/dev/null; then
    fail "$1 registered"
  fi
  kubectl -n "$NS" logs "job/$1" 2>/dev/null >"$WORK/$1.log" || true
  echo "$1: refused ($(grep -oiE 'unauthenticated|giving up[^:]*' "$WORK/$1.log" | head -1))"
}

log "3. Auth: wrong token, no token, plaintext"
next_token=$(openssl rand -hex 24)
kubectl -n "$NS" create secret generic e2e-tokens \
  --from-literal=wrong="$(openssl rand -hex 24)" --from-literal=next="$next_token" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
address='{"name": "PGFSM_GATEWAY_ADDRESS", "value": "https://activity-gateway.pgfsm.svc:7443"}'
worker_job e2e-wrong-token 0 "$address" \
  '{"name": "PGFSM_GATEWAY_TOKEN_FILE", "value": "/etc/pgfsm/token/wrong"}'
worker_job e2e-no-token 0 "$address"
worker_job e2e-plaintext 0 \
  '{"name": "PGFSM_GATEWAY_ADDRESS", "value": "http://activity-gateway.pgfsm.svc:7443"}' \
  '{"name": "PGFSM_GATEWAY_TOKEN_FILE", "value": "/etc/pgfsm/token/wrong"}' \
  '{"name": "PGFSM_RECONNECT_MAX_ATTEMPTS", "value": "2"}'
for job in e2e-wrong-token e2e-no-token e2e-plaintext; do expect_refused "$job"; done
grep -i unauthenticated "$WORK/e2e-wrong-token.log" >/dev/null || fail "e2e-wrong-token: no UNAUTHENTICATED"
grep -i unauthenticated "$WORK/e2e-no-token.log" >/dev/null || fail "e2e-no-token: no UNAUTHENTICATED"

log "3. Auth: a token added to the Secret is accepted without a gateway restart"
gateway_pods_before=$(pods_of activity-gateway | sort)
kubectl -n "$NS" patch secret activity-gateway-tokens --type=json -p \
  "[{\"op\": \"add\", \"path\": \"/data/typescript-next\", \"value\": \"$(printf %s "$next_token" | base64 | tr -d '\n')\"}]" >/dev/null
# The kubelet updates the mounted Secret within about a minute; until then
# the worker is refused, exits, and the Job retries it.
worker_job e2e-rotated 8 "$address" \
  '{"name": "PGFSM_GATEWAY_TOKEN_FILE", "value": "/etc/pgfsm/token/next"}'
secs=$(seconds_until 'Worker "e2e-rotated" authenticated with token "typescript-next"' 300 gateway_logs)
echo "e2e-rotated: accepted ${secs}s after the Secret changed"
[[ "$(pods_of activity-gateway | sort)" == "$gateway_pods_before" ]] || fail "the gateway restarted"
kubectl -n "$NS" delete job e2e-wrong-token e2e-no-token e2e-plaintext e2e-rotated >/dev/null
kubectl -n "$NS" patch secret activity-gateway-tokens --type=json \
  -p '[{"op": "remove", "path": "/data/typescript-next"}]' >/dev/null

# --- 4: rolling restart -------------------------------------------------------

worker_pods() {
  kubectl -n "$NS" get pods -l app.kubernetes.io/component=async-worker \
    -o jsonpath='{range .items[*]}{.metadata.name} {.status.containerStatuses[0].restartCount}{"\n"}{end}' | sort
}

log "4. Gateway rolling restart under load"
before=$(worker_pods)
for lang in "${LANGS[@]}"; do
  load enqueue --language "$lang" --count 40 --work-ms 300 --run-id "$RUN-restart" >/dev/null
done
deadline=$((SECONDS + 120))
until load stats --run-id "$RUN-restart" --json | jq -e '[.languages[] | .succeeded >= 3] | all' >/dev/null; do
  ((SECONDS < deadline)) || fail "no progress before the restart"
  sleep 1
done
restarted_at=$(now)
kubectl -n "$NS" rollout restart deploy/activity-gateway >/dev/null
kubectl -n "$NS" rollout status deploy/activity-gateway --timeout=300s
out=$(drain "$RUN-restart" 600 "${LANGS[@]}")
assert_none_lost "$out"
jq -r '.languages[] | "\(.language): sent \(.sent), succeeded \(.succeeded), redelivered \(.redelivered), duplicates \(.duplicates)"' <<<"$out"
[[ "$(worker_pods)" == "$before" ]] || fail "worker pods changed or restarted: $before → $(worker_pods)"
for lang in "${LANGS[@]}"; do wait_registered "$lang" "$restarted_at"; done

# --- 5: half-open connections -------------------------------------------------

log "5. Half-open: blackhole the TypeScript worker mid-invoke"
pod=$(pods_of async-worker-typescript)
id=$(worker_id "$pod" typescript)
ip=$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.podIP}')
restarts=$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')
# 45 s of work: still running when the path drops, and longer than the
# detection, but shorter than the invoke timeout.
load enqueue --language typescript --count 1 --work-ms 45000 --run-id "$RUN-halfopen" >/dev/null
sleep 5
blackholed_at=$(now)
blackhole "$ip"
echo "dropping $ip ($pod, $id) since $blackholed_at"
worker_logs() { kubectl -n "$NS" logs "$pod" --since-time="$blackholed_at" 2>/dev/null || true; }
since_blackhole() { gateway_logs "$blackholed_at"; }
gw=$(seconds_until "Unregistered worker \"$id\"" 60 since_blackhole)
echo "gateway: unregistered $id after ~${gw}s"
since_blackhole | grep -F "missed a keepalive PING" >/dev/null || fail "the gateway didn't log a missed PING"
since_blackhole | grep -E "WORKER_DISCONNECTED.*leaving message \"?[0-9]+\"? for redelivery" >/dev/null ||
  fail "the in-flight invoke wasn't failed as retriable"
assert_not_restarted "while the gateway noticed"
wk=$(seconds_until "Gateway session ended" 60 worker_logs) || {
  assert_not_restarted "before it logged the session ending"
  exit 1
}
echo "worker: session ended after ~${wk}s"
assert_not_restarted "while the worker noticed"
((gw <= 50 && wk <= 50)) || fail "detection took longer than ~40 s (gateway ${gw}s, worker ${wk}s)"
unblackhole "$ip"
if ! (seconds_until "Worker \"$id\" authenticated" 120 since_blackhole >/dev/null); then
  assert_not_restarted "instead of re-registering"
  exit 1
fi
echo "worker: re-registered"
assert_not_restarted "after the path came back"
out=$(drain "$RUN-halfopen" 300 typescript)
assert_none_lost "$out"
echo "message redelivered and processed: $(jq -c '.languages[0] | {sent, succeeded, redelivered}' <<<"$out")"

log "Acceptance suite passed"
