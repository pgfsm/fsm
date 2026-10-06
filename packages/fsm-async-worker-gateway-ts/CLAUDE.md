# CLAUDE.md — Activity Gateway (`packages/fsm-async-worker-gateway-ts/`)

Scoped guidance for `@pgfsm/async-worker-gateway`. Repo-wide conventions and
session protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

The Activity Gateway for async-operation-type FSM operations across polyglot
(TypeScript/Python/Rust/Go) actors — a standalone alternative to
`fsm-async-worker-ts` (v1, now `@pgfsm/async-worker-old`), not something that
integrates with or is invoked by it. It owns its own poll/dispatch/archive loop
end to end. Two CLIs: `async-operation-worker-gateway` (the long-running
gateway/sidecar/poll-loop process) and `async-operation-worker-gateway-ctl` (a
debug/test client). `README.md` is the npm/npx-consumer-facing document
(published to `dist/` — see below); keep source-only detail here instead of
there.

Full flag reference, examples, and the PGMQ dispatch model live in
[`docs/guides/CLI-USAGE.md`](./docs/guides/CLI-USAGE.md). The goal-vs-current
scoping record (target behavior, comparison table, known gaps) is
[`GOAL.md`](./GOAL.md) — a design/scoping note, not applied code changes.

## Commands

```bash
deno task gateway      # async-operation-worker-gateway — start the gateway
deno task gateway-ctl  # async-operation-worker-gateway-ctl — debug/test client
deno task check        # deno check src/index.ts
deno task test         # deno test --allow-all test/ (also run by CI)
deno task build:npm    # scripts/build-npm.ts (dnt npm build)
```

Deno version is managed by `.prototools`: `proto install deno --pin local`.

## `deploy/`: images and Kubernetes manifests (SPEC-007 step 2a, #457)

- `deploy/docker/gateway.Dockerfile` builds both CLIs from **repository source**
  (context = repo root) with
  `deno compile --no-check
  --node-modules-dir=none`, onto `distroless/cc` as
  non-root. `--node-modules-dir=none` matters: without it, a cold build installs
  the npm workspaces' `node_modules` (database-src, fsm-proto-codegen) and
  embeds them (~700 MB per binary instead of ~140 MB). `--no-check` because
  `pg`'s types don't resolve without those `node_modules`; CI type-checks.
  `--include` the package's `deno.json`, which `version.ts` reads at runtime.
  Each Dockerfile has its own `<name>.Dockerfile.dockerignore` (BuildKit).
- `deploy/docker/worker-<lang>.Dockerfile` take a **generated
  `async-worker/<lang>/`** directory as context (any project, not just
  `test-apps/debug-only`), and are configured through `PGFSM_*` env vars.
- `deploy/k8s/base` is the reference layout (namespace enforcing "restricted",
  gateway Deployment + Service + PDB with `--auth-token-dir`, one worker
  Deployment per language mounting only its own token key). `examples/` (HPA,
  PgBouncer), `single-pod/` (the small topology), `overlays/kind/` (smoke test:
  test Postgres in its own namespace, `smoke.sh`, run by the `k8s-smoke`
  workflow on PRs touching `deploy/` and on demand; a local run needs ~8 GB of
  free Docker disk). kustomize only loads directories from outside an overlay,
  hence `examples/pooler/` with its own kustomization.
- The gateway image is published to GHCR together with the npm package; see
  "Releasing" below. `base/gateway.yaml` and `single-pod/` pin
  `ghcr.io/pgfsm/async-worker-gateway:<deno.json version>`
  (`test/deploy_manifests_test.ts` enforces it, so bump them with the version);
  the kind overlay maps that name back to the locally built `:dev` image, so the
  smoke test still tests the checkout. The Dockerfile fails if the binary's
  `--version` doesn't report its `VERSION` build arg. Worker images aren't
  published (they're per project). The acceptance E2E suite on top of this is
  #458.

## Releasing (`gateway-release.yml`, #486)

One workflow publishes both the npm package and the image from an
`async-worker-gateway-v<version>` tag, in a fixed order so they can't go out of
sync: **preflight → build image (pushed by digest, untagged) → npm publish → tag
image + attest → verify**. (`npm-publish.yml` no longer handles this package.)

- **preflight** fails before anything is published if the tag doesn't match
  `deno.json`, if the `@pgfsm/db` / `@pgfsm/logging` versions in their
  `deno.json` aren't on npm, or if either package's shipped files (not `test/`
  or `*.md`) changed since its own `db-v*` / `logging-v*` tag. The image
  compiles those packages from source while the npm package depends on
  `^<their version>`, so this is what makes both the same code: release them
  first. `workflow_dispatch` has `allow_unreleased_deps` for changes that don't
  ship. `@pgfsm/proto-codegen` comes from the workspace and dnt inlines it, so
  both builds take it from the same commit.
- The image is built before the npm publish (an npm version can't be
  republished) and tagged only after it, so no tagged image exists without its
  npm package. `<version>` always; `<major>.<minor>` / `latest` only when it's
  the newest release of that line / overall, so a dispatch rebuild of an old tag
  (e.g. for a base-image fix) never moves them back. Prereleases get only their
  own image tag and npm dist-tag. amd64 and arm64 build on native runners;
  BuildKit SBOM + provenance, plus a GitHub attestation
  (`gh attestation verify oci://ghcr.io/pgfsm/async-worker-gateway:<v> --owner pgfsm`).
- Every job is safe to re-run (the npm publish is skipped when the version is
  already there): re-run failed jobs to finish a partial release. **verify**
  checks that `npx` and `docker run` both report the version.
- Steps: bump `deno.json` **and** the two manifests' image tag (the test fails
  otherwise) → PR → merge → push the tag. The first image push creates a private
  GHCR package: make it public once in its settings.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt`, modeled on
`fsm-compiler-ts`'s and `fsm-sync-worker-ts`'s build scripts — see
`packages/fsm-compiler-ts/CLAUDE.md`'s "npm publish" section for why dnt (not
`deno pack`) is required to ship CLI `bin` entries. Registers both the library
export and the shebanged `async-operation-worker-gateway`/
`async-operation-worker-gateway-ctl` bins. Published by
`.github/workflows/gateway-release.yml` (see "Releasing"; until #486 it was
`npm-publish.yml`'s `async-worker-gateway` matrix entry, repointed from
`fsm-async-worker-ts`/v1 in #175/#176, once this package took over the
`@pgfsm/async-worker` name in #171). #361 renamed it to
`@pgfsm/async-worker-gateway` (from 0.2.0; tag `async-worker-gateway-v*`), since
it's the gateway workers connect to, not a worker — the worker side is
`@pgfsm/async-worker-sdk`. `@pgfsm/async-worker` (0.1.3–0.1.6) is deprecated on
npm in favour of the new name.

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

This package also depends on `@pgfsm/proto-codegen` (generated
Connect/protobuf/gRPC-Node code, `node:net` usage) — unlike sync-worker's dnt
build, this one has to carry that dependency graph through dnt's type-check and
bundling. Verified clean as of #176; if it breaks again, that's the first place
to look.

**`Deno.remove`/`Deno.removeSync` don't throw `Deno.errors.NotFound` under the
npm/npx build (#278)**: `@deno/shim-deno`'s `remove`/`removeSync` rethrow a
missing-path failure as a raw, unwrapped Node `fs.rm`/`fs.rmSync` error
(`.code === "ENOENT"`) rather than a `Deno.errors.NotFound` instance — unlike
its `stat`/`lstat`/`readTextFile`/`readDir`, which do map through correctly.
This broke `gatewayServer.ts`'s `cleanupUnixSocket` and `sidecar/gateway.ts`'s
`cleanupSocket` (both a best-effort "delete any leftover socket file from a
previous run" that's supposed to ignore a missing one) — the gateway crashed on
startup under `npx` even on a completely fresh run with no stale socket. Use
`src/util.ts`'s `isNotFoundError(error)` instead of a bare
`error
instanceof Deno.errors.NotFound` check anywhere this "ignore a missing
path" pattern is built on a non-recursive `Deno.remove`/`Deno.removeSync` — it
recognizes both real Deno's `Deno.errors.NotFound` and the shim's unwrapped
`ENOENT`. `fsm-compiler-ts` has its own copy of the same helper (its own
`Deno.remove` call sites are a different package, same upstream shim gap) — see
that package's own `CLAUDE.md`.

**Multi-bin `npx` gotcha**: because this package registers two bins and neither
is named `async-worker` (the derived executable name from the package name), a
plain `npx @pgfsm/async-worker-gateway async-operation-worker-gateway ...` does
**not** work — npm can't determine which bin to run and errors
`could
not determine executable to run` (verified empirically against a scratch
multi-bin package). The correct form is
`npx -p @pgfsm/async-worker-gateway -- async-operation-worker-gateway ...` (or a
real install, after which each bin is callable directly) — see `README.md`'s
Install section, which documents this. Same issue applies to
`fsm-sync-worker-ts` (four bins) — see its `CLAUDE.md`.

## Structure (`src/`)

- `cli/` — two CLI entry points (`async-operation-worker-gateway.ts`,
  `async-operation-worker-gateway-ctl.ts`)
- `gatewayServer.ts` — sidecar + gRPC/Connect server, wired together
- `gatewayClient.ts` — client for the gRPC/Connect API (`ActivityGatewayClient`)
- `sidecar/` — worker registration + dispatch (`SidecarGateway`), on one or more
  listeners: Unix socket(s) and/or TCP (SPEC-007)
  - Each listener is its own `http2` server with its own Connect adapter, so the
    Session handler knows which kind it's serving (`ListenerPolicy`). Auth and
    max connection age apply to **TCP sessions only**; Unix sessions are
    unchecked and behave exactly as before.
  - TCP: `createSecureServer` with the listener's cert/key, `minVersion`
    (default TLSv1.3), and for mutual TLS `ca` + `requestCert` +
    `rejectUnauthorized`, so a worker without a valid client certificate fails
    the handshake before any gRPC call. Plaintext only via
    `--insecure-plaintext`.
  - Tokens (#429): `authTokenFile`/`authTokenFiles` and every non-hidden file in
    `authTokenDir`, read **on every new session** (`acceptedTokens()`), so
    tokens can be added and removed without a restart. Hidden entries are
    skipped so a Kubernetes Secret volume's `..data`/`..<timestamp>` aren't
    tokens; `statSync` follows the key symlinks. `authorize()` compares the
    presented header with every token (`safeEqual`, no early exit, so timing
    doesn't reveal which matched) and returns the match's name, which is logged
    with the worker id after `Register`; values are never logged. Empty or
    unreadable sources are skipped; with none left every TCP session is refused
    (fail closed), and `start()` warns. `UNAUTHENTICATED` comes before the
    `Register` is read. Authorization (which token may register which actors) is
    out of scope.
  - Max connection age: a timer per TCP worker (±10 % jitter) marks it
    `draining` (no new invokes, no capacity in `listClaimableActors()`), waits
    for its in-flight invokes up to `connectionDrainGraceMs`, then unregisters
    it and closes its HTTP/2 session (GOAWAY). The handler gets that session
    through an `AsyncLocalStorage` set in the per-listener request handler,
    since Connect's `HandlerContext` doesn't expose the raw connection.
  - Keepalive: per TCP session, a PING every `keepaliveIntervalMs`; no ack
    within `keepaliveTimeoutMs` destroys the session, so the worker is
    unregistered and its in-flight invokes fail as retriable.
  - Tests: `test/sidecar_gateway_capacity_test.ts` (token checks and rotation,
    draining) drives the handler in memory with a TCP policy;
    `test/sidecar_gateway_tcp_test.ts` uses real sockets. Its TLS fixtures (a
    CA, a server cert and a client cert) are generated with `openssl` at test
    time, so no private key is committed (the pre-commit secrets scan would
    reject one) and `openssl` must be on `PATH`.
  - Routing is one actor key → a **set** of workers (#391). Several replicas may
    register the same actor. `invoke()` picks the one with the fewest in-flight
    invokes, rotating on ties. Unregister removes only that worker, and only if
    it is still the current registration for its `workerId` (a stale session
    closing must not tear down a newer re-registration). Covered by
    `test/sidecar_gateway_routing_test.ts`.
  - `stop()` must not wait on workers (#397). The `Session` handler doesn't
    await its request-reader loop once the outbox ends. A worker only ends its
    request stream after it sees the response end, so awaiting it deadlocked
    `stop()` with any worker connected. Both HTTP/2 servers close via
    `util.ts`'s `closeHttp2Server`, which sends GOAWAY and then destroys
    sessions still open after `shutdownGraceMs` (default 5 s). Plain
    `server.close()` waits forever on a client that keeps its connection.
    Covered by `test/sidecar_gateway_stop_test.ts`.
  - Capacity (SPEC-007): each worker declares `max_concurrency` per actor at
    `Register` (0 means 1). `invoke()` picks the worker with the most free slots
    (max_concurrency − its in-flight invokes of that actor).
    `listClaimableActors()` gives the poll loop each actor's free slots, and
    `routingSnapshot()` reports per actor its live workers, Σ max_concurrency
    and in-flight invokes (exposing it is SPEC-008's job). Covered by
    `test/sidecar_gateway_capacity_test.ts`.
- `asyncOpPollLoop.ts` — the Postgres poll/claim/archive loop. It claims at most
  each actor's free slots via
  `claim_pending_async_operation_events_with_capacity_v2`, with a visibility
  timeout of the invoke timeout plus `vtMarginSeconds`. Retriable invoke
  failures (`ActivityInvokeError.retriable`: `ACTOR_NOT_FOUND`,
  `WORKER_UNAVAILABLE`, `WORKER_DISCONNECTED`, `TIMEOUT`, or a worker's
  retriable error) are not archived; the message is redelivered after its
  visibility timeout, until `readCount` reaches `maxDeliveryAttempts` (#396).
  The old `claim_pending_async_operation_events_for_workers_v2` stays until
  nothing calls it. Unit tests in `test/async_op_poll_loop_test.ts`; the
  capacity bound and redelivery against a real database in
  `test/poll_loop_capacity_db_test.ts` (needs `DATABASE_URL`).
