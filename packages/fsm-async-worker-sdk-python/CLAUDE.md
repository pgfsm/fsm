# CLAUDE.md — Python Async Worker SDK (`packages/fsm-async-worker-sdk-python/`)

Scoped guidance for `pgfsm-async-worker-sdk` (import `pgfsm.async_worker_sdk`).
Repo-wide conventions and session protocol live in the root `CLAUDE.md` /
`AGENTS.md`. `README.md` is the PyPI-facing document; keep source-only detail
here.

## Commands

Managed with [uv](https://docs.astral.sh/uv/) (`pyproject.toml` + `uv.lock`).

```bash
uv sync                    # create .venv with deps + dev group (pytest)
uv run pytest -q           # tests (no database; in-process gRPC gateway)
uv build                   # sdist + wheel into dist/
```

## What it is

Python counterpart of `@pgfsm/async-worker-sdk`
(`packages/fsm-async-worker-sdk-ts/`): `ActorWorker`
(`src/pgfsm/async_worker_sdk/actor_worker.py`) and the `list`/`start` CLI
handling `run_actor_worker_cli` (`src/pgfsm/async_worker_sdk/cli.py`). Until
#364, `fsm-compiler-ts` wrote both into every project as
`async-worker/python/sdk.py`/`cli.py` (from `worker-sdk-sdk.eta`/
`worker-sdk-cli.eta`), plus a `requirements.txt` editable-installing
`pgfsm-proto-codegen` from this monorepo. Now `generate-async-logic` writes only
a thin `run_async_worker.py` (`python/run-async-worker.eta`) and a uv
`pyproject.toml` pinning this package (`python/worker-sdk-pyproject.eta`).

Depends on the published `pgfsm-proto-codegen` (PyPI) for the
`pgfsm.sidecargateway.v1` stubs — not the monorepo's
`packages/fsm-proto-codegen/gen/python/` directly. `pgfsm` is a namespace
package shared with it, so there's deliberately no `src/pgfsm/__init__.py`
(`[tool.uv.build-backend] module-name = "pgfsm.async_worker_sdk"`).

`requires-python >= 3.10`: `pgfsm-proto-codegen` itself says `>=3.9`, but its
`protobuf>=7.35.1` pin only supports 3.10+.

## Rules

- **No database access.** This runs inside every actor process; connections stay
  in the gateway (root `CLAUDE.md` point 4).
- **Library only calls `logging.getLogger()`.** The generated
  `run_async_worker.py` configures logging once (`logging.basicConfig`).
- **`run_actor_worker_cli` returns an exit code** instead of calling
  `sys.exit()`, so it stays testable (argparse's own exit-on-error is overridden
  for the same reason). It only installs SIGINT/SIGTERM handlers when called
  from the main thread, and restores the previous ones when it returns.
- **Registration dict keys are the contract with the compiler's registries**
  (`python/actors-registry.eta`, `python/shared-async-op-registry.eta`), which
  don't import from this package — `create-async-logic` writes registries
  without a `pyproject.toml`. Keep the keys in sync if either side changes.
- `ActorWorker.run()` closes its gRPC channel before returning.

## Tests

`tests/test_actor_worker.py` runs `ActorWorker` end to end against a fake
`SidecarGatewayService` (a real grpcio server built from the same stubs) on a
temp Unix socket: register, invoke, handler error → `INTERNAL`, unknown actor →
`NOT_FOUND`, unregister on stop, rejected registration, and the CLI's `start`
path. `tests/test_cli.py` covers the CLI's exit codes. CI runs both (`ci.yml`,
`python-async-worker-sdk` job).

## PyPI publish

`.github/workflows/pypi-publish.yml`, from an `async-worker-sdk-py-v<version>`
tag; the tag must match `pyproject.toml`'s `version`. Trusted publishing (OIDC)
through the `pypi` environment — PyPI needs a trusted publisher for
`pgfsm-async-worker-sdk` naming that workflow file.

The compiler's `worker-sdk-pyproject.eta` pins
`pgfsm-async-worker-sdk>=0.1.0,<0.2`. Bump that pin by hand when this package's
API changes in a way `run-async-worker.eta`'s call depends on.

Inside this repo, the committed `apps/async-worker/python/pyproject.toml` uses
that same pin, so `uv run run_async_worker.py` there only works once the
matching version is published (same as the TypeScript worker with
`@pgfsm/async-worker-sdk`). Before then, run it with this package's own
environment:
`.venv/bin/python ../../apps/async-worker/python/run_async_worker.py start`.

## Known behaviour

A handler runs on the gRPC response thread, so invokes are served one at a time
per worker (same as the pre-#364 generated `sdk.py`). Async handlers are run
with `asyncio.run()` per invoke.
