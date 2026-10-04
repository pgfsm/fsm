#!/usr/bin/env bash
# kind smoke test for the reference manifests (SPEC-007 step 2a, #457):
# builds the gateway and one worker image per language, deploys them with the
# base manifests into a Pod Security "restricted" namespace, and checks that
# every language's worker registers over TLS with its own token and serves an
# invoke.
#
# Usage (from anywhere in the repository):
#   packages/fsm-async-worker-gateway-ts/deploy/k8s/overlays/kind/smoke.sh
#
# Environment:
#   KIND           kind command (default: kind; e.g. "go run sigs.k8s.io/kind@v0.33.0")
#   CLUSTER        kind cluster name (default: pgfsm-smoke)
#   SKIP_CLUSTER   1 = use the current kubectl context's cluster as is (CI creates it)
#   SKIP_BUILD     1 = images are already built
#   KEEP           1 = leave the cluster running afterwards
set -euo pipefail

KIND=${KIND:-kind}
CLUSTER=${CLUSTER:-pgfsm-smoke}
ROOT=$(git rev-parse --show-toplevel)
HERE="$ROOT/packages/fsm-async-worker-gateway-ts/deploy/k8s/overlays/kind"
DOCKER_DIR="$ROOT/packages/fsm-async-worker-gateway-ts/deploy/docker"
WORKERS="$ROOT/test-apps/debug-only/async-worker"
LANGS=(typescript python rust go)
NS=pgfsm
WORK=$(mktemp -d)

log() { printf '\n==> %s\n' "$*"; }

# The actor each language's debug-only worker serves (no associative arrays:
# macOS ships Bash 3.2).
actor_for() {
  case $1 in
    typescript | python) echo checkBureau ;;
    rust) echo checkBureauRust ;;
    go) echo CheckReportsTable ;;
  esac
}

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    log "FAILED: diagnostics"
    kubectl get pods -A -o wide || true
    kubectl -n "$NS" describe pods || true
    kubectl -n "$NS" logs -l app.kubernetes.io/part-of=pgfsm --all-containers --tail=80 --prefix || true
  fi
  rm -rf "$WORK"
  if [[ "${KEEP:-0}" != 1 && "${SKIP_CLUSTER:-0}" != 1 ]]; then
    $KIND delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  fi
  exit $status
}
trap cleanup EXIT

if [[ "${SKIP_CLUSTER:-0}" != 1 ]]; then
  log "Creating kind cluster $CLUSTER"
  $KIND get clusters 2>/dev/null | grep -qx "$CLUSTER" || $KIND create cluster --name "$CLUSTER" --wait 120s
  kubectl config use-context "kind-$CLUSTER" >/dev/null
fi

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  deno_version=$(sed -n 's/^deno = "\(.*\)"/\1/p' "$ROOT/.prototools")
  log "Building images (Deno $deno_version)"
  DOCKER_BUILDKIT=1 docker build -q -f "$DOCKER_DIR/gateway.Dockerfile" \
    --build-arg "DENO_VERSION=$deno_version" -t pgfsm/async-worker-gateway:dev "$ROOT"
  for lang in "${LANGS[@]}"; do
    DOCKER_BUILDKIT=1 docker build -q -f "$DOCKER_DIR/worker-$lang.Dockerfile" \
      --build-arg "DENO_VERSION=$deno_version" -t "pgfsm/async-worker-$lang:dev" "$WORKERS/$lang"
  done
fi
log "Loading images into kind"
for image in pgfsm/async-worker-gateway:dev "${LANGS[@]/#/pgfsm/async-worker-}"; do
  [[ $image == *:dev ]] || image="$image:dev"
  $KIND load docker-image --name "$CLUSTER" "$image"
done

log "Postgres (test-only) + migrations"
kubectl apply -f "$HERE/postgres.yaml"
kubectl -n pgfsm-db rollout status deploy/postgres --timeout=300s
pg_pod=$(kubectl -n pgfsm-db get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}')
for migration in "$ROOT"/packages/database-src/supabase/migrations/*.sql; do
  kubectl -n pgfsm-db exec -i "$pg_pod" -- \
    psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <"$migration" >/dev/null
done

log "Namespace, TLS material, tokens and database Secrets"
kubectl apply -f "$ROOT/packages/fsm-async-worker-gateway-ts/deploy/k8s/base/namespace.yaml"
(
  cd "$WORK"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ca.key -out ca.crt \
    -subj /CN=pgfsm-smoke-ca 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout tls.key -out tls.csr \
    -subj /CN=activity-gateway.pgfsm.svc 2>/dev/null
  printf 'subjectAltName=DNS:activity-gateway.pgfsm.svc,DNS:activity-gateway.pgfsm.svc.cluster.local,DNS:activity-gateway\n' >san.ext
  openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 \
    -out tls.crt -extfile san.ext 2>/dev/null
  for lang in "${LANGS[@]}"; do openssl rand -hex 24 >"token-$lang"; done
)
kubectl -n "$NS" create secret tls activity-gateway-tls \
  --cert="$WORK/tls.crt" --key="$WORK/tls.key" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create configmap activity-gateway-ca \
  --from-file=ca.crt="$WORK/ca.crt" --dry-run=client -o yaml | kubectl apply -f -
token_args=()
for lang in "${LANGS[@]}"; do token_args+=("--from-file=$lang=$WORK/token-$lang"); done
kubectl -n "$NS" create secret generic activity-gateway-tokens "${token_args[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret generic pgbouncer-upstream \
  --from-literal=DB_HOST=postgres.pgfsm-db.svc --from-literal=DB_PORT=5432 \
  --from-literal=DB_USER=postgres --from-literal=DB_PASSWORD=postgres \
  --from-literal=DB_NAME=postgres --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret generic activity-gateway-db \
  --from-literal=DATABASE_URL=postgresql://postgres:postgres@pgbouncer.pgfsm.svc:5432/postgres \
  --dry-run=client -o yaml | kubectl apply -f -

log "Applying the manifests (overlays/kind)"
kubectl apply -k "$HERE"
for deploy in pgbouncer activity-gateway "${LANGS[@]/#/async-worker-}"; do
  kubectl -n "$NS" rollout status "deploy/$deploy" --timeout=300s
done

log "Pod Security: the namespace admits every pod under \"restricted\""
warnings=$(kubectl label --dry-run=server --overwrite ns "$NS" \
  pod-security.kubernetes.io/enforce=restricted 2>&1 | grep -i warning || true)
if [[ -n "$warnings" ]]; then
  echo "$warnings"
  exit 1
fi

log "Every worker registered with its own token"
gateway_pods=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=activity-gateway -o jsonpath='{.items[*].metadata.name}')
for lang in "${LANGS[@]}"; do
  found=""
  for _ in $(seq 1 60); do
    for pod in $gateway_pods; do
      if kubectl -n "$NS" logs "$pod" | grep -q "authenticated with token \"$lang\""; then
        found=$pod
        break 2
      fi
    done
    sleep 2
  done
  [[ -n "$found" ]] || { echo "no gateway log shows the $lang worker authenticating"; exit 1; }
  echo "$found" >"$WORK/pod-$lang"
  echo "$lang: authenticated on $found"
done
if kubectl -n "$NS" logs -l app.kubernetes.io/name=activity-gateway --tail=-1 |
  grep -qFf <(cat "$WORK"/token-*); then
  echo "a token value appears in the gateway logs"
  exit 1
fi

log "One invoke per language, through the gateway replica its worker is on"
for lang in "${LANGS[@]}"; do
  out=$(kubectl -n "$NS" exec "$(cat "$WORK/pod-$lang")" -- \
    /usr/local/bin/async-operation-worker-gateway-ctl invoke \
    --parent-fsm-name creditCheck --parent-fsm-version v01 \
    --async-operation-type internalAsyncOperation \
    --async-operation-name "$(actor_for "$lang")" --async-operation-version v01 \
    --async-operation-language "$lang" --input '{"smoke":true}' --timeout-ms 15000 2>&1)
  echo "$out" | grep -q "Result:" || { echo "$lang invoke failed: $out"; exit 1; }
  echo "$lang: $(echo "$out" | grep -o 'Result: .*' | cut -c1-100)"
done

log "Smoke test passed"
