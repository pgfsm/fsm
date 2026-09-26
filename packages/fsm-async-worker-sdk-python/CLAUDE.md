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

## Releasing

`.github/workflows/pypi-publish.yml` publishes to PyPI when an
`async-worker-sdk-py-v<version>` tag is pushed. It runs these steps in order,
and stops at the first failure:

1. Check the tag's version against `uv version --short`.
2. Run `uv run --locked pytest -q`. `--locked` fails if `uv.lock` is stale.
3. `uv build`.
4. Upload with trusted publishing (OIDC), through the `pypi` environment.
   `skip-existing` makes a re-run safe.

This release is independent of `pgfsm-proto-codegen`, which publishes from
`proto-publish.yml` on `proto-v*` tags. The README's "Releasing (maintainers)"
section has the short version; the full procedure is below.

### Procedure

1. **Pick the version** (below 1.0): a breaking API change → minor; new
   backward-compatible features → minor; fixes only → patch.
2. **Bump it in an issue-linked PR**, from this directory:
   `uv version --bump minor|patch` (or `uv version X.Y.Z`). That rewrites
   `pyproject.toml` and `uv.lock` together; commit both. For prereleases, uv
   stores PEP 440 form: `uv version 0.2.0-alpha.0` writes `0.2.0a0`, so the tag
   is `async-worker-sdk-py-v0.2.0a0`.
3. **If the new version needs a newer `pgfsm-proto-codegen`:** release
   proto-codegen first (`proto-v*`, see `packages/fsm-proto-codegen/README.md`'s
   "Releasing a new version"). Then raise the `pgfsm-proto-codegen>=` pin in
   `pyproject.toml` (and run `uv lock`) in this PR. Otherwise installing the SDK
   fails to resolve.
4. **After merge, with `main` green, tag and push:**
   `git fetch origin && git tag async-worker-sdk-py-v<version> origin/main && git push origin async-worker-sdk-py-v<version>`.
   A pushed tag publishes publicly and can't be undone, so agents only push one
   when the user asks.
5. **Check the release:** watch the run
   (`gh run list --workflow pypi-publish.yml`), then install it from PyPI into a
   fresh venv and import `pgfsm.async_worker_sdk`.

### Letting generated projects use a new minor version

Generated projects pin `pgfsm-async-worker-sdk>=0.1.0,<0.2`, so they won't pick
up `0.2.0` until that pin moves. Update it in the same PR as the bump, or a
follow-up once the release is on PyPI. It lives in:

- `packages/fsm-compiler-ts/src/scaffold-templates/eta/python/worker-sdk-pyproject.eta`,
  then, in `packages/fsm-compiler-ts`, run
  `deno task generate:templates && deno fmt src/scaffold-templates` to refresh
  `worker-sdk-pyproject.generated.ts`. The generator writes unformatted output,
  so without the `deno fmt` every `*.generated.ts` shows a formatting-only diff.
- `packages/fsm-compiler-ts/test/operation-logic-scaffold.test.ts`, which
  asserts the pin string.
- `apps/async-worker/python/pyproject.toml`, the committed generated copy (the
  `dependencies` pin and its pip comment).
- `DEVELOPER.md`'s pip install example.

Patch releases need none of this: the existing `<0.2` range already allows them.

### If something goes wrong

- **Tag/version mismatch:** nothing was published. Delete the tag
  (`git push origin :refs/tags/<tag> && git tag -d <tag>`), fix the cause, and
  tag again.
- **Tests or the upload failed:** fix the cause and re-run the failed job.
  Re-running is safe because `skip-existing` skips files already uploaded.
- **A bad version shipped:** PyPI never accepts the same version twice. Release
  the next patch, then yank the bad one on pypi.org.

### One-time setup (done)

- The `pypi` GitHub environment has a deployment rule allowing tags
  `async-worker-sdk-py-v*` (next to `proto-v*`). Without it, the job is rejected
  before it starts.
- PyPI has a trusted publisher for `pgfsm-async-worker-sdk`: owner `pgfsm`,
  repository `fsm`, workflow `pypi-publish.yml`, environment `pypi`. Renaming
  the workflow file or the environment breaks publishing until this is updated
  to match.

### Using the SDK from `apps/async-worker/python` before a release

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
