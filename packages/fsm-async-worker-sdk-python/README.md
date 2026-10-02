# pgfsm-async-worker-sdk

Python worker SDK for the pgfsm Activity Gateway. A worker process built on it
connects to the gateway's sidecar (over its Unix socket, or over TCP with TLS, a
bearer token and/or mutual TLS), registers a set of actors, and serves the
invocations the gateway routes to them over the
`pgfsm.sidecargateway.v1.SidecarGatewayService` gRPC stream (stubs from
[`pgfsm-proto-codegen`](https://pypi.org/project/pgfsm-proto-codegen/)).

It never opens a database connection — that stays in the gateway.

Python counterpart of the TypeScript
[`@pgfsm/async-worker-sdk`](https://www.npmjs.com/package/@pgfsm/async-worker-sdk).

## Usage

You normally don't write against this package directly. `@pgfsm/compiler`'s
`generate-async-logic` writes a small `run_async_worker.py` plus a
`pyproject.toml` that pins this package:

```python
# async-worker/python/run_async_worker.py (generated)
import logging
import sys

from pgfsm.async_worker_sdk import run_actor_worker_cli
from python_actors_registry_generated import ACTOR_REGISTRATIONS

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    raise SystemExit(run_actor_worker_cli(ACTOR_REGISTRATIONS, sys.argv[1:]))
```

Run it from that directory with [uv](https://docs.astral.sh/uv/):

```bash
uv run run_async_worker.py list    # print the actors in the registry, no gateway needed
uv run run_async_worker.py start   # connect to the gateway and serve invocations
# the gateway as its own Deployment: TLS + bearer token, 10 invokes at once
uv run run_async_worker.py start \
  --gateway-address https://activity-gateway:7443 \
  --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
```

or with pip: `python3 -m pip install pgfsm-async-worker-sdk`, then
`python3 run_async_worker.py start`.

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
                              max_concurrency (default: 1; see "Concurrency")
    --keepalive-interval-ms <ms>
                              HTTP/2 PING interval over TCP (default: 30000; 0 disables)
    --keepalive-timeout-ms <ms>
                              Reconnect when a PING goes unanswered this long (default: 10000)
    --shutdown-grace-ms <ms>  On SIGINT/SIGTERM, how long in-flight invokes get to finish (default: 25000)
-i, --worker-id <id>          Stable worker identity (default: python-<random>)
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

### Environment variables

Every option except `--help` can also be set through an environment variable:
`PGFSM_` + the long option name in upper case, with `-` as `_`. The names are
the same in all four worker SDKs (TypeScript, Python, Rust, Go).

| Flag                           | Variable                           |
| ------------------------------ | ---------------------------------- |
| `--gateway-socket`             | `PGFSM_GATEWAY_SOCKET`             |
| `--gateway-address`            | `PGFSM_GATEWAY_ADDRESS`            |
| `--gateway-ca-file`            | `PGFSM_GATEWAY_CA_FILE`            |
| `--gateway-token-file`         | `PGFSM_GATEWAY_TOKEN_FILE`         |
| `--gateway-cert-file`          | `PGFSM_GATEWAY_CERT_FILE`          |
| `--gateway-key-file`           | `PGFSM_GATEWAY_KEY_FILE`           |
| `--max-concurrency`            | `PGFSM_MAX_CONCURRENCY`            |
| `--keepalive-interval-ms`      | `PGFSM_KEEPALIVE_INTERVAL_MS`      |
| `--keepalive-timeout-ms`       | `PGFSM_KEEPALIVE_TIMEOUT_MS`       |
| `--shutdown-grace-ms`          | `PGFSM_SHUTDOWN_GRACE_MS`          |
| `--worker-id`                  | `PGFSM_WORKER_ID`                  |
| `--heartbeat-ms`               | `PGFSM_HEARTBEAT_MS`               |
| `--reconnect-initial-delay-ms` | `PGFSM_RECONNECT_INITIAL_DELAY_MS` |
| `--reconnect-max-delay-ms`     | `PGFSM_RECONNECT_MAX_DELAY_MS`     |
| `--reconnect-max-attempts`     | `PGFSM_RECONNECT_MAX_ATTEMPTS`     |

- **Precedence: flag → variable → default.** An empty variable counts as unset.
- `--gateway-socket` and `--gateway-address` count as one setting: a flag for
  either overrides both variables, and setting both variables is an error.
- Credentials stay **file paths** (`PGFSM_GATEWAY_TOKEN_FILE` names the token
  file, not the token), so secrets never sit in the environment.
- A bad value exits 1 before connecting, naming the variable.
- Variables are read from `run_actor_worker_cli`'s `env` argument (default
  `os.environ`). The SDK doesn't load `.env` files itself; use
  `uv run --env-file .env run_async_worker.py start`.

### Connecting over TCP (SPEC-007)

When the gateway runs as its own Deployment, point workers at its Service with
`--gateway-address https://<service>:<port>`:

- **TLS.** `--gateway-ca-file` trusts the gateway's certificate. The gateway
  requires TLS 1.3 by default; grpcio supports it.
- **Bearer token.** `--gateway-token-file` sends the token the gateway checks
  (`--auth-token-file` there). It's re-read on every reconnect, so a rotated
  Secret is picked up without restarting the worker. A wrong token is
  `UNAUTHENTICATED`, which ends `start` with exit code 1.
- **Mutual TLS.** `--gateway-cert-file`/`--gateway-key-file` present a client
  certificate when the gateway requires one (`--tls-client-ca` there).
  Certificate files are also re-read on every reconnect.
- **Keepalive.** Over TCP the worker PINGs the gateway, so a half-open
  connection is noticed and the worker reconnects.
- **Rebalancing.** Every session uses a new channel. When the gateway drains the
  worker after its max connection age, the worker reconnects through the Service
  and may land on another gateway replica.

`http://host:port` is only for a gateway started with `--insecure-plaintext`
(local testing).

### Concurrency

By default each actor handles **one invoke at a time**. To run more, set:

- `--max-concurrency <n>` (or `max_concurrency=` on `ActorWorker`): the
  worker-wide default for every actor;
- `"max_concurrency"` in an actor's registration: that actor's own limit, which
  wins over the worker-wide one.

The effective limit per actor is **its own `max_concurrency`, else the worker's,
else 1**. It's sent to the gateway at registration, so the gateway claims and
routes no more than that, and the worker also enforces it locally: extra invokes
of an actor wait for a slot.

Each invoke runs on its own thread; an `async def` handler runs in its own event
loop on that thread (`asyncio.run`). **Above 1, handlers must be thread-safe.**
State shared across calls (module-level variables, caches, counters, a client
that isn't thread-safe) can change under a running invoke. Keep per-invoke state
local, and share only clients that are safe across threads. Since every async
invoke has its own event loop, don't share loop-bound objects (an
`aiohttp.ClientSession`, an asyncio lock) between invokes. CPU-bound pure-Python
handlers gain little from threads because of the GIL; scale them out with more
worker replicas instead. Concurrency helps handlers that wait on I/O.

Separately from concurrency, **handlers must be idempotent**: delivery is
at-least-once, so an actor may run again for the same message (after a worker or
gateway restart, a dropped connection, or a timeout).

### Stopping

`stop()` (and SIGINT/SIGTERM under `run_actor_worker_cli`) drains: invokes that
arrive while stopping are refused with a retriable `WORKER_DRAINING` error, so
the gateway delivers them again to another worker, and in-flight invokes are
allowed to finish for up to `shutdown_grace_ms` (default 25 s; keep it below
your pod's termination grace period). Then the worker unregisters and
disconnects. `stop()` returns immediately (it's safe to call from a signal
handler); `run()` returns once the drain is over.

## API

- `run_actor_worker_cli(registrations, args, invocation=None) -> int` — the
  `list`/`start` CLI. Returns the process exit code instead of exiting.
- `ActorWorker(worker_id, gateway_socket_path=None, registrations=None,
  heartbeat_ms=5000, reconnect_initial_delay_ms=250,
  reconnect_max_delay_ms=30000, reconnect_max_attempts=0, *,
  gateway_address=None, ca_file=None, token_file=None, cert_file=None,
  key_file=None, keepalive_interval_ms=30000, keepalive_timeout_ms=10000,
  max_concurrency=None, shutdown_grace_ms=25000)`
  — `run()` registers every actor and serves invocations until `stop()` is
  called, reconnecting and re-registering whenever a session drops. It raises
  `RegistrationRejectedError` on an explicit rejection, `grpc.RpcError` on a
  fatal gRPC code, or `ConnectionError` after `reconnect_max_attempts`
  consecutive failed attempts. Pass `gateway_address` or `gateway_socket_path`
  (shorthand for `unix:<path>`).
- `parse_gateway_address(address) -> GatewayAddress` and
  `effective_max_concurrency(actor_max, worker_max) -> int` — the helpers the
  worker and CLI use.

A registration is a dict:

```python
{
    "parent_fsm_name": "creditCheck",
    "parent_fsm_version": "v01",
    "async_operation_type": "internalAsyncOperation",
    "async_operation_name": "checkBureau",
    "async_operation_version": "v01",
    "async_operation_language": "python",
    "handler": check_bureau,  # (input) -> JSON-serializable output; may be async
    "max_concurrency": 4,     # optional: this actor's own limit (see "Concurrency")
}
```

A handler that raises is reported to the gateway as an `INTERNAL` invoke error;
an invoke for an unregistered actor is reported as `NOT_FOUND`.

Logging goes through the standard `logging` module (`pgfsm.async_worker_sdk`
loggers); the library never configures logging itself.

## Releasing (maintainers)

Released from the [pgfsm/fsm](https://github.com/pgfsm/fsm) monorepo by
`.github/workflows/pypi-publish.yml`. Pushing an
`async-worker-sdk-py-v<version>` tag publishes to PyPI with trusted publishing
(no API token). This package releases independently of
[`pgfsm-proto-codegen`](https://pypi.org/project/pgfsm-proto-codegen/).

1. **Pick the version.** While below 1.0: breaking API change → minor (`0.1.0` →
   `0.2.0`); new backward-compatible features → minor; fixes only → patch
   (`0.1.0` → `0.1.1`).
2. **Bump it in a PR.** From `packages/fsm-async-worker-sdk-python`:

   ```bash
   uv version --bump minor     # or: --bump patch, or an exact version: uv version 0.2.0
   ```

   This updates `pyproject.toml` and `uv.lock` together; commit both. If the new
   version needs a newer `pgfsm-proto-codegen`, release that first, then raise
   the `pgfsm-proto-codegen>=` pin here.
3. **Tag the merge commit and push the tag.** The tag must be exactly
   `async-worker-sdk-py-v` + `uv version --short`:

   ```bash
   git fetch origin
   git tag async-worker-sdk-py-v0.2.0 origin/main
   git push origin async-worker-sdk-py-v0.2.0
   ```

4. **Check the release.** `gh run list --workflow pypi-publish.yml` shows the
   run, which checks the tag against `pyproject.toml`, runs the tests, builds,
   and uploads. Then confirm https://pypi.org/project/pgfsm-async-worker-sdk/
   lists the version and it installs:
   `pip install pgfsm-async-worker-sdk==0.2.0`.

For prereleases, uv writes the version in PEP 440 form
(`uv version 0.2.0-alpha.0` stores `0.2.0a0`), so tag
`async-worker-sdk-py-v0.2.0a0`. pip only installs a prerelease if asked
explicitly (`--pre` or an exact `==` version).

A published version can never be re-uploaded. If a bad version ships, release
the next patch and yank the bad one on pypi.org. Yanked versions stay
installable when pinned exactly, but resolvers skip them otherwise.

## License

Apache-2.0
