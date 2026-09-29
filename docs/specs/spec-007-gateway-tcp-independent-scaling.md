# SPEC-007: Activity Gateway as an Independently Scalable Deployment

| Field   | Value                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                                                                                          |
| Date    | 2026-09-27                                                                                                                                                                                                                                                     |
| Authors | Niraj, Claude                                                                                                                                                                                                                                                  |
| Issue   | #393                                                                                                                                                                                                                                                           |
| Affects | `packages/fsm-async-worker-gateway-ts`, `packages/fsm-async-worker-sdk-{ts,python,rust,go}`, `packages/fsm-proto-codegen` (`sidecar_gateway.proto`), `packages/database-src` (claim function), `packages/fsm-core-db-ts` (claim wrapper), `docs/adr/adr-003-…` |

---

## Problem

Today polyglot async-operation workers (TS/Python/Rust/Go) reach the Activity
Gateway **only** over its sidecar Unix socket (`--sidecar-socket`, default
`/tmp/pgfsm-activity-gateway-workers.sock`). On Kubernetes that forces one
topology: a single pod holding the gateway plus every language worker, sharing
the socket through an `emptyDir`. The unit of scaling is "one gateway + one of
each language". That breaks down on four fronts, all of them hitting us now as
we prepare to deploy to K8s:

1. **Uneven load per language.** If Python actors need 10× the capacity of Go,
   the only knob is scaling the whole pod, which also scales Go, TS, Rust, and
   the gateway.
2. **Separate release cycles.** Rolling out one language's worker image restarts
   the gateway and every other language in the same pod.
3. **pg connection budget.** Every pod replica is a gateway replica holding its
   own pg Pool, so connections grow with _worker_ scale. ADR-003 says they must
   not.
4. **An imminent K8s deployment** needs a supported, documented topology.

Scaling workers also adds no throughput today. The gateway's poll loop
(`asyncOpPollLoop.ts`) calls `claim_pending_async_operation_events_for_workers`,
which does `pgmq.read(queue, 30, 1)` per registered actor identity: **1 message
per actor per poll tick (default 30 s) per gateway**, whether 1 or 10 workers
serving that actor are connected. So even with a topology that lets a language
scale independently, adding replicas changes nothing.

Two known bugs also block any scaled topology:

- **#391:** `SidecarGateway.actorRoutes` maps each actor to one worker (last
  registration wins), and `unregisterWorker` deletes routes another worker has
  since taken over.
- **#392:** none of the 4 SDKs reconnect or re-register after the gateway
  restarts, or retry if the socket doesn't exist yet.

## Constraints

- **ADR-003 — zero DB connections on the polyglot side.** Workers never open a
  DB connection; only the gateway holds a pg Pool. Connections must not scale
  with the number of worker processes.
- **ADR-003 — separate scaling axes.** "API, orchestrator fleet, and each
  language's activity fleet scale independently." This spec is what makes that
  true for the activity tier.
- **ADR-003 — "No confirmed container runtime."** **This spec revises that
  constraint:** Kubernetes is now the production deploy target. Unix-socket mode
  stays the default for local dev and single-host setups, so nothing that runs
  without containers today stops working.
- **ADR-003 — connection pooler in front of Postgres.** Gateway pools stay small
  (`max: 2–5`) behind a transaction pooler.
- **Worker ↔ gateway security** on a shared network: the gateway serves **TLS**,
  and workers authenticate with a **bearer token** (from a K8s Secret). No
  service mesh is assumed.
- **Existing wire protocol.** The sidecar leg is already gRPC (Connect over
  `node:http2`, `pgfsm.sidecargateway.v1.SidecarGatewayService`, one
  bidirectional `Session` stream per worker). Only its listener is Unix-only.
- **Scale envelope:** unknown for now. Design for elasticity (HPA/KEDA on worker
  Deployments) without hard numbers.

## Options considered

### Option A — Status quo + bug fixes (5-container pod)

Keep gateway and all 4 language workers in one pod over an `emptyDir` Unix
socket; fix #391 and #392.

- **Pros:** No transport change, no auth surface, works today.
- **Cons:** Fails problems 1–3: languages can't scale or release independently,
  and pg Pools grow with pod count. Doesn't address the claim ceiling.

### Option B — Gateway DaemonSet + `hostPath` socket

One gateway per node writing its socket to a `hostPath`; worker Deployments
mount the same `hostPath`.

- **Pros:** No transport change. pg Pools are bounded by node count, and a
  gateway only claims work for actors registered on its node.
- **Cons:** `hostPath` is blocked by the `baseline`/`restricted` Pod Security
  profiles and often by managed clusters. Workers are tied to their node, one
  gateway per node caps throughput, and bin-packing can pile a language's
  replicas onto one node. A gateway rollout drops every worker on the node.
  **Rejected.**

### Option C — Gateway Deployment; workers dial in over TCP (push) — **chosen**

The gateway runs as its own Deployment behind a ClusterIP Service. The sidecar
listener gains a TCP mode, and workers dial `https://<service>:<port>`. It keeps
today's push model: the gateway sends `Invoke` down each worker's `Session`
stream.

- Add **TLS + bearer token** on the TCP listener.
- **Capacity-aware claim:** each worker declares `max_concurrency` per actor at
  `Register`. The gateway claims, per actor, up to Σ(`max_concurrency` −
  in-flight) over its connected workers, instead of 1.
- **Rebalancing:** K8s Services balance per connection, so workers reconnect
  after a max connection age (with jitter). That spreads them across gateway
  replicas added by scale-out.
- **Pros:** Small change, because the protocol is already gRPC. SDKs keep their
  shape; only the dial target and a few fields are added. Gateway replica count
  is set on its own, which bounds pg Pools. Each gateway claims only what its
  own workers can take, so an uneven worker spread can't overload anyone.
- **Cons:** Load across gateways can drift until the next reconnect cycle. The
  gateway becomes a network service (certs, token rotation).

### Option D — Worker pull / lease

Workers call a unary `Lease(actor, n)` RPC, and the gateway claims from PGMQ on
demand for that lease; results come back via `Complete`.

- **Pros:** Capacity-aware by construction. Any L7 load balancer spreads load
  exactly, with no sticky streams.
- **Cons:** Rewrites the protocol in all 4 SDKs. Many small on-demand DB claims
  instead of one batched claim per tick. Adds latency from worker-side polling.

### Option E — Gateway dials workers

Workers run gRPC servers. The gateway discovers them via a headless Service or
the Endpoints API and opens the streams itself.

- **Pros:** The gateway fully controls fan-out and balancing.
- **Cons:** Needs RBAC for the Endpoints API. Inverts all 4 SDKs (every worker
  becomes a server). Every gateway connects to every worker (N×M) unless
  sharded. Most operational complexity.

### Option F — Workers talk to Postgres directly

- **Rejected outright:** violates ADR-003's zero-DB-connections property (this
  is ADR-003's own rejected Option A).

## Decision

**Option C: gateway Deployment, workers dial in over TCP with TLS + bearer
token, with capacity-aware claiming and a visibility timeout derived from the
invoke timeout.**

**Deciding driver: minimal change / ship soon.** K8s deployment is imminent.
Option C reuses the existing `Session` bidi stream, message set, and SDK
structure; the transport change is mostly a listen address and a dial target. It
solves all four problems:

- Each language is its own Deployment/HPA, so it scales and releases on its own
  (problems 1, 2).
- Gateway replicas are a separate, small knob, so pg connections equal gateway
  replicas × pool max, however many workers run (problem 3).
- It is a plain Deployment + Service + Secret, needing no `hostPath`, RBAC, or
  mesh (problem 4).

Why the others lose on that driver:

- **A** doesn't solve problems 1–3.
- **B** is quick but blocked by Pod Security and ties workers to nodes.
- **D** and **E** give better balancing but mean a protocol rewrite (D) or
  inverting the SDKs (E) in 4 languages. That isn't worth it until measured
  imbalance under C proves otherwise. D stays the documented fallback if
  reconnect-based rebalancing proves insufficient.

### Design details

1. **Transport** (`fsm-async-worker-gateway-ts`)
   - `--sidecar-socket` is joined by `--sidecar-listen <target>`, accepting
     `unix:<path>` (default, today's behavior) or `tcp://<host>:<port>`.
     - Validate that at least one of `--sidecar-socket` / `--sidecar-listen` is
       set.
     - Serving both at once is allowed, which helps migration.
   - TCP mode uses `http2.createSecureServer` with `--tls-cert` / `--tls-key`.
     - Plaintext TCP requires explicit `--insecure-plaintext` and logs a warning
       (for local testing only).
   - Auth: `--auth-token-file <path>`. When set, a `Session` whose
     `authorization: Bearer <token>` header doesn't match (constant-time
     compare) is rejected with `UNAUTHENTICATED` before `Register` is processed.
     - The file is re-read on change, so a mounted Secret can be rotated without
       a restart.
     - Unix mode may omit the token.
   - The gateway sets an HTTP/2 **max connection age**
     (`--max-connection-age-ms`, default 10 min ± 10 % jitter), then sends
     GOAWAY once in-flight invokes drain or a grace period ends.
   - **Keepalive:** on TCP, the gateway and the SDKs enable HTTP/2 keepalive
     pings (`--keepalive-interval-ms`, default 30 s; `--keepalive-timeout-ms`,
     default 10 s). Today's heartbeat only goes from worker to gateway, and the
     gateway never replies, so a half-open connection (NetworkPolicy blackhole,
     node loss) would otherwise go unnoticed on both sides. A Unix socket
     doesn't need this: a crash there shows up immediately as end-of-stream or a
     reset.
2. **SDKs** (all 4 languages, consistent flags)
   - `--gateway-socket <path>` stays. It is joined by
     `--gateway-address
     <unix:path | https://host:port>`, plus
     `--gateway-ca-file` and `--gateway-token-file`.
   - Reconnect with exponential backoff + jitter (#392): re-send `Register` on
     every new session, and treat GOAWAY / max-age as a normal reconnect.
   - Graceful drain on SIGTERM: stop taking new invokes, finish in-flight
     invokes within a grace period, then close.
3. **Proto** (`sidecar_gateway.proto`, additive)
   - `RegisteredActor.max_concurrency` (`uint32`, field 9; `0` ⇒ 1).
4. **Routing** (#391)
   - `actorRoutes: Map<actorKey, Set<workerId>>`.
   - Per invoke, pick the worker with the most free slots (least in-flight
     relative to `max_concurrency`).
   - Unregister removes only that worker from each set.
5. **Capacity-aware claim** (`database-src` + `fsm-core-db-ts`)
   - A new versioned claim function takes, per actor identity, `qty` (the
     aggregate free slots) and `vt_seconds`, and calls
     `pgmq.read(queue, vt_seconds, qty)`.
   - The gateway skips actors with 0 free slots.
   - The old function stays until nothing calls it.
6. **Visibility timeout**
   - `vt_seconds = ceil((actor timeout_ms or --invoke-timeout-ms) / 1000) +
     margin`
     (default margin 10 s).
   - No claimed message becomes visible again while its invoke may still be
     running.
   - At-least-once delivery remains (a gateway crash mid-invoke re-delivers
     after `vt`). Actor handlers must be idempotent, and this is documented.
7. **Reference manifests** (plain YAML, no Helm) under
   `packages/fsm-async-worker-gateway-ts/deploy/k8s/`:
   - gateway Deployment + Service + TLS/token Secret, with a PodDisruptionBudget
     for the gateway;
   - one worker Deployment per language;
   - an example HPA;
   - the gateway's pg connection pointed at the pooler.
   - The existing single-pod (`emptyDir`) layout is documented alongside it as
     the "small / local" topology.

## Consequences & migration

**What gets harder**

- The gateway is now a network service: TLS certs and the token Secret must be
  issued and rotated (cert-manager or manual). There are more places to
  misconfigure (Service port, CA trust, token mismatch).
- Load across gateway replicas can drift until the next max-connection-age
  cycle. After a gateway scale-out, new replicas take work only as workers
  reconnect.
- An invoke now crosses pod boundaries. Debugging spans the gateway pod, the
  Service, and the worker pod, and network partitions surface as invoke timeouts
  plus re-delivery after `vt`.
- Actor idempotency moves from "nice to have" to a documented requirement
  (at-least-once already held in principle; it becomes more likely in practice).
- ADR-003's "no confirmed container runtime" constraint is amended: K8s is a
  supported production target.

**Migration** (purely additive; each step shippable alone)

1. Land #391 (multi-worker routing), #392 (SDK reconnect), #396 (retriable
   invoke failures re-dispatched instead of archived) and #397
   (`SidecarGateway.stop()` hang). All are correctness fixes even in the
   single-pod topology. #396 is what makes gateway rolling restarts lossless,
   and #397 is what makes them graceful.
2. Proto `max_concurrency` field + capacity-aware claim function + derived `vt`.
   This lifts the 1-message-per-tick ceiling for the single-pod topology too.
3. Gateway TCP listener + TLS + token; SDK `--gateway-address`/TLS/token flags.
4. Reference manifests. Move one language at a time: deploy the gateway
   Deployment, then repoint that language's worker Deployment at the Service
   while the other languages stay in the old pod.

**Rollback**

- Transport: point workers back at `unix:` in the single-pod layout; the Unix
  listener never goes away.
- Claim: the gateway can be pinned to the old claim function. The new function
  is additive, and there is no data migration.
- Proto: `max_concurrency` is an additive field that old gateways ignore.

## Acceptance criteria

- [ ] **Multi-worker routing (#391):** with workers A and B registering the same
      actor on one gateway, invokes go to both. Unregistering A leaves B's route
      intact. Covered by a gateway unit test.
- [ ] **Reconnect (#392):** each SDK started before the gateway waits and
      connects once the gateway comes up. After a gateway restart, each SDK
      reconnects and re-registers without the worker process restarting. Covered
      by an integration test per language.
- [ ] **Throughput scales with replicas:** doubling one language's worker
      replicas (same `max_concurrency`) roughly doubles that language's
      processed messages per minute under a saturated queue (≥ 1.8×), with no
      change to other languages' throughput. Verified E2E on a K8s cluster (kind
      is acceptable).
- [ ] **Claim is capacity-bounded:** a gateway never has more in-flight invokes
      for an actor than Σ `max_concurrency` of its connected workers for that
      actor. Verified by test.
- [ ] **No premature re-delivery:** for an actor whose invoke takes longer than
      30 s but less than its `timeout_ms`, the message is processed exactly once
      (no duplicate claim).
- [ ] **Gateway restart survives:** a rolling restart of the gateway Deployment
      under load loses no messages. Every claimed message is archived or
      re-delivered after `vt`, and workers reconnect and re-register without
      being restarted. Verified E2E.
- [ ] **Connections bounded:** Postgres backend connections from the activity
      tier equal gateway replicas × pool max (+ any LISTEN connections),
      independent of worker replica count (checked at 1 and N worker replicas
      via `pg_stat_activity`). Verified E2E.
- [ ] **Auth:** over TCP, a worker with a missing or wrong token is refused with
      `UNAUTHENTICATED` before registration. A plaintext connection to a TLS
      listener fails. Rotating the token file is picked up without a gateway
      restart. Verified E2E.
- [ ] **Half-open connections are detected over TCP:** the gateway and the SDKs
      enable HTTP/2 keepalive pings on the TCP transport (default 30 s interval,
      10 s timeout, configurable). If the network drops without a clean close,
      both sides notice within about 40 s. The worker reconnects, and the
      gateway unregisters the worker and fails its in-flight invokes as
      retriable (see #396). Verified E2E.
- [ ] **Unix mode unchanged:** with no new flags, gateway and SDKs behave
      exactly as today (default Unix socket paths, no TLS/token required).
- [ ] **Flag parity:** all 4 SDKs expose the same `--gateway-address`,
      `--gateway-ca-file`, and `--gateway-token-file` flags and reconnect
      behavior, documented in each README.
- [ ] **Reference manifests** apply cleanly to a kind cluster and pass the E2E
      checks above, and the Pod Security `restricted` profile admits them (no
      `hostPath`, non-root).
- [ ] ADR-003 is amended: the "no confirmed container runtime" constraint is
      revised to reference this spec.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->

Prerequisites:

- #391: multi-worker routing (merged in #395).
- #392: SDK reconnect with backoff (PR #398).
- #396: retriable invoke failures are archived as actor errors instead of
  re-dispatched.
- #397: `SidecarGateway.stop()` hangs while a worker is connected.
