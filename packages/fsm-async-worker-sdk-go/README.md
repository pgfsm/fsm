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
```

To add it to your own module:
`go get github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go@latest`.

### Options

```
-g, --gateway-socket <path>   Sidecar socket to connect to (default: /tmp/pgfsm-activity-gateway-workers.sock)
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

SIGINT/SIGTERM stop the worker gracefully (it unregisters from the gateway).

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

## API

- `RunActorWorkerCLI(registrations, args, invocation) int`: the `list`/`start`
  CLI. Returns the process exit code instead of exiting. `invocation` is shown
  in `--help`; `""` means `go run .`.
- `NewActorWorker(ActorWorkerOptions{WorkerID, GatewaySocketPath, HeartbeatMs, ReconnectInitialDelayMs, ReconnectMaxDelayMs, ReconnectMaxAttempts}, registrations)`:
  `Run()` registers every actor and serves invocations until `Stop()` is called
  (returns `nil`), reconnecting and re-registering whenever a session drops. It
  returns `ErrRegistrationRejected` on an explicit rejection, or an error after
  `ReconnectMaxAttempts` consecutive failed attempts (zero values mean the
  defaults: 250 ms, 30 s, retry forever). `Stop()` is safe from any goroutine,
  before `Run()` connects, and during a reconnect backoff.
- `NewActorRegistration(parentFsmName, parentFsmVersion, asyncOperationType, asyncOperationName, asyncOperationVersion, asyncOperationLanguage, handler)`,
  where `handler` is a `func(input any) (any, error)`.

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
