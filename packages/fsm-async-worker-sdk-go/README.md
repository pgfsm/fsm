# fsm-async-worker-sdk-go

Go worker SDK for the pgfsm Activity Gateway
(`github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go`, package
`asyncworkersdk`). A worker process built on it connects to the gateway's
sidecar Unix socket, registers a set of actors, and serves the invocations the
gateway routes to them over the `pgfsm.sidecargateway.v1.SidecarGatewayService`
gRPC stream (stubs from the
`github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go` module).

It never opens a database connection — that stays in the gateway.

Go counterpart of the TypeScript
[`@pgfsm/async-worker-sdk`](https://www.npmjs.com/package/@pgfsm/async-worker-sdk),
the Python
[`pgfsm-async-worker-sdk`](https://pypi.org/project/pgfsm-async-worker-sdk/) and
the Rust
[`pgfsm-async-worker-sdk`](https://crates.io/crates/pgfsm-async-worker-sdk).

## Usage

You normally don't write against this module directly. `@pgfsm/compiler`'s
`generate-async-logic` writes a small `main.go` plus a `go.mod` that requires
this module:

```go
// async-worker/go/main.go (generated, abridged)
package main

import (
	"os"

	generatedregistry "fsm-core-example/go-actors-registry-generated"
	asyncworkersdk "github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go"
)

func main() {
	generated := generatedregistry.ActorRegistrations()
	registrations := make([]asyncworkersdk.ActorRegistration, 0, len(generated))
	for _, reg := range generated {
		registrations = append(registrations, asyncworkersdk.NewActorRegistration(
			reg.ParentFsmName, reg.ParentFsmVersion, reg.AsyncOperationType,
			reg.AsyncOperationName, reg.AsyncOperationVersion, reg.AsyncOperationLanguage,
			reg.Handler,
		))
	}
	os.Exit(asyncworkersdk.RunActorWorkerCLI(registrations, os.Args[1:], ""))
}
```

Run it from that directory:

```bash
go run . list    # print the actors in the registry, no gateway needed
go run . start   # connect to the gateway and serve invocations
# the gateway as its own Deployment: TLS + bearer token, 10 invokes at once
go run . start --gateway-address https://activity-gateway:7443 \
  --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
```

To add it to your own module:
`go get github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go@latest`.

### Options

```
-g, --gateway-socket <path>   Sidecar socket to connect to (default: /tmp/pgfsm-activity-gateway-workers.sock)
-a, --gateway-address <addr>  Gateway sidecar address instead: unix:<path>, https://host:port,
                              or http://host:port (the gateway's --insecure-plaintext test mode)
    --gateway-ca-file <file>  PEM CA bundle to trust the gateway's TLS certificate (default: system roots)
    --gateway-token-file <file>
                              Bearer token sent as `authorization: Bearer`; re-read on every reconnect
    --gateway-cert-file <file>
    --gateway-key-file <file> Client certificate and key for mutual TLS
-c, --max-concurrency <n>     Invokes of each actor run at once, for actors without their own
                              MaxConcurrency (default: 1; see "Concurrency")
    --keepalive-interval-ms <ms>
                              HTTP/2 PING interval over TCP (default: 30000; 0 disables;
                              grpc-go raises anything below 10000 to 10000)
    --keepalive-timeout-ms <ms>
                              Reconnect when a PING goes unanswered this long (default: 10000)
    --shutdown-grace-ms <ms>  On SIGINT/SIGTERM, how long in-flight invokes get to finish (default: 25000)
-i, --worker-id <id>          Stable worker identity (default: go-<random>)
    --heartbeat-ms <ms>       Heartbeat interval (default: 5000)
    --reconnect-initial-delay-ms <ms>
                              First reconnect backoff step (default: 250)
    --reconnect-max-delay-ms <ms>
                              Reconnect backoff cap (default: 30000)
    --reconnect-max-attempts <n>
                              Exit after n consecutive failed attempts (default: 0 = retry forever)
-h, --help                    Show this help message
```

Invalid flags (both `--gateway-socket` and `--gateway-address`, an unknown
address scheme, a certificate without its key, a missing credentials file, an
out-of-range or non-integer number) exit 1 before connecting.

`start` doesn't need the gateway to be up first: it retries the connection with
exponential backoff (full jitter, 250 ms doubling up to 30 s), and if a session
drops (e.g. the gateway restarts) it reconnects and re-registers on its own. A
session only resets the backoff once it has stayed up for 10 s, so a gateway
that accepts and immediately drops still gets backed off from. `start` ends with
exit code 1 only on what reconnecting can't fix: an explicit registration
rejection; a gRPC `UNAUTHENTICATED`, `PERMISSION_DENIED`, `UNIMPLEMENTED` or
`INVALID_ARGUMENT` (a misconfiguration, so it fails fast instead of retrying);
or `--reconnect-max-attempts` consecutive failed attempts. An invoke result that
can't be sent because its session ended is logged and dropped; the gateway has
already failed that invoke.

### Connecting over TCP (SPEC-007)

When the gateway runs as its own Deployment, point workers at its Service with
`--gateway-address https://<service>:<port>`:

- **TLS.** `--gateway-ca-file` trusts the gateway's certificate; without it the
  system roots are used. The gateway requires TLS 1.3 by default; Go's
  `crypto/tls` supports it.
- **Bearer token.** `--gateway-token-file` sends the token the gateway checks
  (`--auth-token-file` there). It's re-read on every reconnect, so a rotated
  Secret is picked up without restarting the worker. A wrong token is
  `UNAUTHENTICATED`, which ends `start` with exit code 1.
- **Mutual TLS.** `--gateway-cert-file`/`--gateway-key-file` present a client
  certificate when the gateway requires one (`--tls-client-ca` there).
  Certificate files are also re-read on every reconnect.
- **Keepalive.** Over TCP the worker PINGs the gateway, so a half-open
  connection is noticed and the worker reconnects.
- **Rebalancing.** Every session uses a new connection. When the gateway drains
  the worker after its max connection age, the worker reconnects through the
  Service and may land on another gateway replica.

`http://host:port` is only for a gateway started with `--insecure-plaintext`
(local testing).

### Concurrency

By default each actor handles **one invoke at a time**. To run more, set:

- `--max-concurrency <n>` (or `MaxConcurrency` in `ActorWorkerOptions`): the
  worker-wide default for every actor;
- `.WithMaxConcurrency(n)` on an actor's `ActorRegistration`: that actor's own
  limit, which wins over the worker-wide one.

The effective limit per actor is **its own `MaxConcurrency`, else the worker's,
else 1**. It's sent to the gateway at registration, so the gateway claims and
routes no more than that, and the worker also enforces it locally: extra invokes
of an actor wait for a slot.

Each invoke runs on its own goroutine. **Above 1, handlers must be safe for
concurrent use**: guard state shared across calls (package-level variables,
maps, caches, counters) with a `sync.Mutex`, atomics or channels, and share only
clients documented as safe for concurrent use. `go test -race` finds most
mistakes. Keep per-invoke state local. Goroutines spread over all cores, so
CPU-bound handlers scale up to the limit you set.

Separately from concurrency, **handlers must be idempotent**: delivery is
at-least-once, so an actor may run again for the same message (after a worker or
gateway restart, a dropped connection, or a timeout).

### Stopping

`Stop()` (and SIGINT/SIGTERM under `RunActorWorkerCLI`) drains: invokes that
arrive while stopping are refused with a retriable `WORKER_DRAINING` error, so
the gateway delivers them again to another worker, and in-flight invokes are
allowed to finish for up to `ShutdownGraceMs` (default 25 s; keep it below your
pod's termination grace period). Then the worker unregisters and disconnects.
`Stop()` doesn't block; `Run()` returns `nil` once the drain is over. A handler
still running when the grace period ends can't be stopped from outside its
goroutine: its result is dropped, and the process exits when `main` returns.

## API

- `RunActorWorkerCLI(registrations, args, invocation) int`: the `list`/`start`
  CLI. Returns the process exit code instead of exiting. `invocation` is shown
  in `--help`; `""` means `go run .`.
- `NewActorWorker(ActorWorkerOptions{...}, registrations)`: `Run()` registers
  every actor and serves invocations until `Stop()` is called (returns `nil`
  after the drain), reconnecting and re-registering whenever a session drops.
  Set `GatewayAddress` (`https://host:port`, plus `CAFile`, `TokenFile`,
  `CertFile`/`KeyFile` as needed) or `GatewaySocketPath`. Zero values mean the
  defaults for `HeartbeatMs`, `ReconnectInitialDelayMs` (250 ms),
  `ReconnectMaxDelayMs` (30 s), `ReconnectMaxAttempts` (retry forever),
  `MaxConcurrency` (1), `KeepaliveIntervalMs`/`KeepaliveTimeoutMs` (30 s / 10 s;
  a negative interval disables keepalive) and `ShutdownGraceMs` (25 s; a
  negative value doesn't wait). `Run()` returns `ErrRegistrationRejected` on an
  explicit rejection, the gRPC status on a fatal code, or an error for an
  invalid address or after `ReconnectMaxAttempts` consecutive failed attempts.
  `Stop()` is safe from any goroutine, before `Run()` connects, and during a
  reconnect backoff.
- `NewActorRegistration(parentFsmName, parentFsmVersion, asyncOperationType, asyncOperationName, asyncOperationVersion, asyncOperationLanguage, handler)`,
  where `handler` is a `func(input any) (any, error)`, optionally followed by
  `.WithMaxConcurrency(n)`.
- `ParseGatewayAddress(address)` and
  `EffectiveMaxConcurrency(actorMax, workerMax)`: the helpers the worker and CLI
  use.

Go can't practically load a function from a source file at runtime, so actors
are linked into the worker binary. If an actor function is missing or has the
wrong signature, the worker fails to compile instead of failing at startup.

A handler that returns an error or panics is reported to the gateway as an
`INTERNAL` invoke error (the worker keeps running); an invoke for an
unregistered actor is reported as `NOT_FOUND`.

Logging goes through `log/slog`'s default logger; configure it with
`slog.SetDefault` before calling `RunActorWorkerCLI` to change the format or
level.

## Releasing (maintainers)

Released from the [pgfsm/fsm](https://github.com/pgfsm/fsm) monorepo by
`.github/workflows/go-publish.yml`. Pushing an `async-worker-sdk-go-v<version>`
tag runs the tests, then pushes the module tag
`packages/fsm-async-worker-sdk-go/v<version>`, which is what Go actually
resolves. Go modules have no registry upload and no version field in `go.mod`:
the tag is the release.

1. **Pick the version.** While below 1.0: breaking API change → minor (`0.1.0` →
   `0.2.0`); new backward-compatible features → minor; fixes only → patch
   (`0.1.0` → `0.1.1`). 2.0.0 and later also need the module path in `go.mod` to
   end in `/v2`.
2. **Land the change in a PR.** Nothing to bump in the module itself. If it
   needs a newer proto-codegen Go module, release that first and
   `go get github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go@v<new>` here.
3. **Tag the merge commit and push the tag:**

   ```bash
   git fetch origin
   git tag async-worker-sdk-go-v0.2.0 origin/main
   git push origin async-worker-sdk-go-v0.2.0
   ```

4. **Check the release.** `gh run list --workflow go-publish.yml` shows the run.
   Then
   `go list -m github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go@v0.2.0`
   should resolve.

A released version can't be changed: the Go checksum database records it
permanently, so never move or re-push a module tag. If a bad version ships,
release the next patch with a `retract v0.2.0 // reason` directive in `go.mod`.

## License

Apache-2.0
