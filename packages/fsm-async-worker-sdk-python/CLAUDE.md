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
  `max_concurrency` is optional and the registries don't emit it yet (#435).
- `ActorWorker.run()` closes its gRPC channel before returning.

## Tests

`tests/test_actor_worker.py` runs `ActorWorker` end to end against a fake
`SidecarGatewayService` (a real grpcio server built from the same stubs) on a
temp Unix socket: register, invoke, handler error → `INTERNAL`, unknown actor →
`NOT_FOUND`, unregister on stop, rejected registration, and the CLI's `start`
path. `tests/test_transport_concurrency.py` covers SPEC-007 over real TCP
sockets (see below). `tests/test_cli.py` covers the CLI's exit codes and flag
validation. CI runs all of them (`ci.yml`, `python-async-worker-sdk` job).

## Transport, concurrency and drain (SPEC-007, #432)

Same behaviour as the TypeScript SDK (#431); keep the two in step.

- **Addresses.** `gateway_address` (`unix:` / `https://` / `http://`) is parsed
  once by `parse_gateway_address`; `gateway_socket_path` is shorthand for
  `unix:`. `_open_channel()` builds a **new** grpc channel per session (so a
  reconnect after the gateway's max-age drain can reach another replica), and
  reads the token, CA and client certificate then, so rotated files apply from
  the next session. The token goes as call metadata (`authorization: Bearer`),
  not call credentials, so it also works on the plaintext test mode.
- **Keepalive** is grpc channel options (`grpc.keepalive_time_ms`,
  `grpc.keepalive_timeout_ms`, and `grpc.http2.max_pings_without_data` 0,
  without which grpc-core stops pinging a quiet stream after two PINGs). TCP
  only.
- **TLS failures are retried.** Unlike connect-node (see the TS SDK's
  CLAUDE.md), grpc-core reports a refused handshake (no client certificate, an
  untrusted server) as `UNAVAILABLE` on the call, so `run()` retries it with
  backoff; no special handling needed.
- **Concurrency.** `_serve_loop` no longer runs handlers inline: each invoke
  gets its own thread, and each actor a `threading.Semaphore` sized by
  `effective_max_concurrency(reg.get("max_concurrency"), max_concurrency)`
  (actor, else worker, else 1), which is also sent in `Register`. The local
  semaphore matters: the gateway can briefly send more than declared.
- **Drain.** `stop()` doesn't block (it's called from the signal handler): it
  sets `_stopping`, and a drain thread waits for the in-flight invoke threads up
  to `shutdown_grace_ms`, then sets `_stopped` and closes the session. Invokes
  that arrive while `_stopping` get a retriable `WORKER_DRAINING`. `run()`
  doesn't reconnect once stopping and returns after `_stopped`. An invoke thread
  is added to `_in_flight` and started under `_lock`, the same lock `stop()`
  takes, so the drain never misses one or sees an unstarted thread.
- **`_Session.send()`** returns False once the session is closed; that's how a
  late result is detected and logged as dropped.

Tests: `tests/test_transport_concurrency.py` runs a grpcio server (TLS/mTLS via
`grpc.ssl_server_credentials`, max age via `grpc.max_connection_age_ms`) that
checks the bearer token like the real gateway: TLS + token, token re-read after
a reconnect, wrong token, mTLS with/without a client certificate, an untrusted
server certificate, plaintext, worker-wide and per-actor concurrency, drain and
its grace limit, max-age reconnect. TLS fixtures come from `openssl` at test
time (`tests/conftest.py`'s `tls` fixture; no committed keys). The real
connect-node gateway isn't started here (it's Deno); interop with it was checked
by hand for #432 (mTLS + token, concurrency, max-age reconnect, drain, wrong
token).

## Environment variables (#438)

Every CLI option except `--help` falls back to `PGFSM_<LONG_NAME>` (`-` → `_`):
flag → variable → default, an empty variable counts as unset, and
`--gateway-socket`/`--gateway-address` are one setting (a flag for either
overrides both variables). Same option list (`ENV_OPTIONS`/`EnvOptions`), names,
precedence and error messages in all four SDKs; change them together.
`resolve_settings(flags, env)` in `cli.py`; argparse keeps every env-backed
option `default=None` with no `type=`, so "flag given" is detectable and one
validator covers flags and variables. `run_actor_worker_cli(..., env=)` defaults
to `os.environ`. Tests in `tests/test_cli.py`. No `.env` loading in the SDK: the
CLI is library code inside the user's process, so the README points at
`--env-file` (Deno, uv) or `set -a`.

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

Generated projects pin `pgfsm-async-worker-sdk>=0.2.0,<0.3`, so they won't pick
up `0.3.0` until that pin moves. Update it in the same PR as the bump, or a
follow-up once the release is on PyPI. It lives in:

- `packages/fsm-compiler-ts/src/scaffold-templates/eta/python/worker-sdk-pyproject.eta`,
  then, in `packages/fsm-compiler-ts`, run
  `deno task generate:templates && deno fmt src/scaffold-templates` to refresh
  `worker-sdk-pyproject.generated.ts`. The generator writes unformatted output,
  so without the `deno fmt` every `*.generated.ts` shows a formatting-only diff.
- `packages/fsm-compiler-ts/test/operation-logic-scaffold.test.ts`, which
  asserts the pin string.
- `test-apps/debug-only/async-worker/python/pyproject.toml`, the committed
  generated copy (the `dependencies` pin and its pip comment).
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

### Using the SDK from source

[`test-apps/debug-only/`](../../test-apps/debug-only/README.md) (#405) is the
in-repo worker project. Its Python worker uses the published package; to run it
against this directory, add a `[tool.uv.sources]` editable path to its
`async-worker/python/pyproject.toml` (see that README's "Using local SDK
source"). `uv run run_async_worker.py start` there then picks up local changes
without a release.

## Known behaviour

Each invoke runs on its own thread, bounded per actor (default 1, so one at a
time as before #432). Async handlers run with `asyncio.run()` per invoke, so
each has its own event loop: loop-bound objects can't be shared across invokes.
Over a Unix socket there's no keepalive: a crash there shows up immediately as
end of stream.
