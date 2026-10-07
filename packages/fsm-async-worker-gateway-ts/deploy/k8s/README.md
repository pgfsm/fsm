# Kubernetes reference manifests (SPEC-007)

Plain YAML (with a kustomization) for running the Activity Gateway as its own
Deployment, with one worker Deployment per language that dials in over TLS. See
[SPEC-007](../../../../docs/specs/spec-007-gateway-tcp-independent-scaling.md)
for the design.

```
base/                  the reference layout: kubectl apply -k base
  namespace.yaml       namespace "pgfsm", Pod Security "restricted" enforced
  gateway.yaml         gateway Deployment (2 replicas) + Service + PodDisruptionBudget
  worker-config.yaml   PGFSM_* settings every worker reads
  worker-<lang>.yaml   one worker Deployment per language
examples/
  hpa.yaml             scale one language's workers
  pooler/              a PgBouncer pooler for the gateway's DATABASE_URL
single-pod/            the small / local topology (one pod, Unix socket)
overlays/kind/         the smoke test: kind overlay, test Postgres, smoke.sh
../docker/             Dockerfiles for the gateway and the workers
```

## Topologies

|                 | Separate Deployments (`base/`)                   | Single pod (`single-pod/`)         |
| --------------- | ------------------------------------------------ | ---------------------------------- |
| Transport       | TCP + TLS + bearer token (optionally mutual TLS) | Unix socket on a shared `emptyDir` |
| Scaling         | Gateway and each language scale independently    | Everything scales together         |
| Gateway restart | Workers reconnect to another replica             | Restarts the whole pod             |
| Setup           | TLS certificate, token Secret, CA for workers    | None beyond the database Secret    |

Start with the single pod for local or small installs. Move to `base/` when one
language needs more workers, or the gateway must survive restarts without taking
every worker down.

## What you need first

The gateway connects to Postgres; the workers never do. Each worker needs only
the gateway's address, its CA and its own token.

1. **Images.** The gateway's is published with every release as
   `ghcr.io/pgfsm/async-worker-gateway:<version>` (amd64 and arm64, with build
   provenance), and `base/` already pulls the current one. Workers run your
   project's actors, so build those from the [Dockerfiles](../docker/), push
   them to your registry and replace the `pgfsm/async-worker-<lang>:dev` names
   (e.g. with kustomize's `images:`).

   ```bash
   # one per language: from your generated project's async-worker/<lang>/
   docker build -f .../deploy/docker/worker-python.Dockerfile -t <registry>/async-worker-python:<tag> async-worker/python
   # the gateway too, if you'd rather build it: from this repository's root
   docker build -f packages/fsm-async-worker-gateway-ts/deploy/docker/gateway.Dockerfile \
     -t <registry>/async-worker-gateway:<tag> .
   ```

   Check where a published gateway image came from with
   `gh attestation verify oci://ghcr.io/pgfsm/async-worker-gateway:<version> --owner pgfsm`.

2. **TLS certificate** for the gateway. It must name the Service host the
   workers dial: `activity-gateway.pgfsm.svc` (see `worker-config.yaml`).
   cert-manager works, or by hand:

   ```bash
   kubectl -n pgfsm create secret tls activity-gateway-tls --cert=tls.crt --key=tls.key
   kubectl -n pgfsm create configmap activity-gateway-ca --from-file=ca.crt=ca.crt
   ```

   TLS 1.3 is the gateway's minimum by default. For mutual TLS instead of (or as
   well as) tokens, add `--tls-client-ca` to the gateway and mount a client
   certificate into each worker (`PGFSM_GATEWAY_CERT_FILE` /
   `PGFSM_GATEWAY_KEY_FILE`).

3. **Tokens, one per language.** The gateway mounts the whole Secret as
   `--auth-token-dir` (every key is one accepted token); each worker mounts only
   its own key, so a leaked token exposes one language.

   ```bash
   kubectl -n pgfsm create secret generic activity-gateway-tokens \
     --from-literal=typescript=$(openssl rand -hex 24) \
     --from-literal=python=$(openssl rand -hex 24) \
     --from-literal=rust=$(openssl rand -hex 24) \
     --from-literal=go=$(openssl rand -hex 24)
   ```

   **Rotating a token** without refusing anyone: add the new value under a new
   key (e.g. `python-2`) — the gateway accepts both from its next session —
   point the Python Deployment's `items` at the new key and let it roll, then
   delete the old key. The gateway re-reads the directory for every session and
   logs which key each worker used, never the value.

4. **Database URL**, pointed at a pooler (examples/pooler/, or your managed
   database's own pooler):

   ```bash
   kubectl -n pgfsm create secret generic activity-gateway-db \
     --from-literal=DATABASE_URL=postgresql://<user>:<password>@<pooler>:5432/postgres
   ```

   Postgres connections from the activity tier are gateway replicas × the
   gateway's pool size (node-postgres' default of 10), however many workers run.

Then:

```bash
kubectl apply -k packages/fsm-async-worker-gateway-ts/deploy/k8s/base
```

## Moving from the single pod, one language at a time

The gateway keeps serving its Unix socket alongside TCP, so the move is additive
(SPEC-007, migration step 4):

1. Deploy the gateway Deployment and Service (`gateway.yaml`), with the Secrets
   above.
2. Deploy one language's worker Deployment (e.g. `worker-python.yaml`) and
   remove that language's container from the single pod.
3. Repeat per language. Then remove the single pod.

**Rollback:** run that language's worker in the single pod again (pointing at
the socket); the gateway's Unix listener never goes away. Nothing in the
database changes.

## Pod Security

Every pod in `base/` and `single-pod/` meets the **restricted** profile: runs as
non-root (uid 65532), no privilege escalation, all capabilities dropped,
`RuntimeDefault` seccomp, read-only root filesystem (an `emptyDir` at `/tmp` for
sockets and scratch), no `hostPath`. The namespace enforces it, so a pod that
doesn't comply isn't admitted.

## Scaling and disruptions

- **Workers:** add replicas of one language's Deployment, or raise
  `PGFSM_MAX_CONCURRENCY` / an actor's own `maxConcurrency`. The gateway claims
  only what connected workers can take (Σ `max_concurrency` per actor), so
  replicas are what raise throughput. `examples/hpa.yaml` scales on CPU; queue
  depth (e.g. KEDA's PostgreSQL scaler on the pgmq queue) is the better signal.
- **Gateway:** 2 replicas behind the Service, with a PodDisruptionBudget of
  `minAvailable: 1`. Workers are drained and reconnected every 10 minutes
  (`--max-connection-age-ms`), so they spread over new replicas after a
  scale-out.
- **Shutdown:** workers refuse new invokes as retriable on SIGTERM and finish
  in-flight ones within `PGFSM_SHUTDOWN_GRACE_MS` (25 s), inside the pods' 30 s
  termination grace. Delivery is at-least-once: actor handlers must be
  idempotent.

## Smoke test on kind

`overlays/kind/smoke.sh` builds the images, creates a kind cluster, runs a
test-only Postgres (Supabase's image) with the repo's migrations, deploys
`base/` plus the example pooler, and checks that:

- every pod is admitted under Pod Security "restricted";
- every language's worker, started before any gateway replica exists, is refused
  and keeps retrying, then registers over TLS with its own token once the
  gateway is up, and no token value appears in the gateway's logs;
- one invoke per language round-trips through the gateway replica its worker is
  connected to.

**In CI:** the `k8s-smoke` workflow runs it on every pull request that changes
`deploy/` or the workflow, and on demand (Actions → k8s-smoke → Run workflow).

**Locally:**

- Needs Docker with **at least ~8 GB of free disk** (five images, kind's node
  image, a second copy of each image loaded into kind, and Postgres), `kubectl`,
  `openssl`, `git`, and kind (or Go, to run kind without installing it).
- It switches your kubectl context to `kind-pgfsm-smoke`, and deletes the
  cluster afterwards unless `KEEP=1`. Switch back with
  `kubectl config use-context <your context>`.

```bash
packages/fsm-async-worker-gateway-ts/deploy/k8s/overlays/kind/smoke.sh
# without installing kind:
KIND="go run sigs.k8s.io/kind@v0.33.0" packages/fsm-async-worker-gateway-ts/deploy/k8s/overlays/kind/smoke.sh
# keep the cluster to look around afterwards:
KEEP=1 packages/fsm-async-worker-gateway-ts/deploy/k8s/overlays/kind/smoke.sh
```

Free the space again afterwards with
`docker rmi pgfsm/async-worker-gateway:dev pgfsm/async-worker-{typescript,python,rust,go}:dev`.

The acceptance checks that need a loaded cluster (throughput, rolling restarts,
connection bounds, half-open connections) are #458.
