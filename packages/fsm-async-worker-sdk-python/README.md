# pgfsm-async-worker-sdk

Python worker SDK for the pgfsm Activity Gateway. A worker process built on it
connects to the gateway's sidecar Unix socket, registers a set of actors, and
serves the invocations the gateway routes to them over the
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
```

or with pip: `python3 -m pip install pgfsm-async-worker-sdk`, then
`python3 run_async_worker.py start`.

### Options

```
-g, --gateway-socket <path>   Sidecar socket to connect to (default: /tmp/pgfsm-activity-gateway-workers.sock)
-i, --worker-id <id>          Stable worker identity (default: python-<random>)
    --heartbeat-ms <ms>       Heartbeat interval (default: 5000)
-h, --help                    Show this help message
```

SIGINT/SIGTERM stop the worker gracefully (it unregisters from the gateway).

## API

- `run_actor_worker_cli(registrations, args, invocation=None) -> int` — the
  `list`/`start` CLI. Returns the process exit code instead of exiting.
- `ActorWorker(worker_id, gateway_socket_path, registrations, heartbeat_ms=5000)`
  — `run()` registers every actor and serves invocations until `stop()` is
  called or the gateway ends the stream.

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
