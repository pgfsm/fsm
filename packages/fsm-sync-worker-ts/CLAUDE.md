# CLAUDE.md — Worker Fleet (`packages/fsm-sync-worker-ts/`)

Scoped guidance for `@pgfsm/sync-worker`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

The `fsmlet` runtime library: the out-of-band worker that drives FSM instances
forward (see root `CLAUDE.md` point 3 — the API never owns worker lifecycle).
Kubernetes-style split: `fsmlet` (kubelet — long-running node agent) is assigned
dispatch entries by the scheduler — the `pg_cron` job (SPEC-003), with
`pgfsmctl scheduler run` as a fallback — and instances are driven one-shot by
`pgfsmctl instance …` or the HTTP API.

**Library only (SPEC-005).** The `fsmctl`, `pgcron` and `fsmscheduler` bins, the
`src/fsmscheduler/` loop (`runFsmScheduler` and friends) and
`docs/guides/CLI-USAGE.md` moved to `@pgfsm/ctl` (`packages/fsm-ctl-ts/`, bin
`pgfsmctl`). Don't add CLI bins back here: ops commands that act on the database
belong in `@pgfsm/ctl`, and project scaffolding in `@pgfsm/cli`. A pgfsm project
runs this library through its generated
`sync-worker/typescript/run-sync-worker.ts`.

The equivalent for promise/callback-based async operations is the Activity
Gateway (`packages/fsm-async-worker-gateway-ts/`); the deprecated v1 trio lives
in `packages/fsm-async-worker-ts/` — see their `CLAUDE.md` files.

## Commands

```bash
deno task check        # deno check src/index.ts
deno task test         # deno test --allow-all test/ (DB tests need DATABASE_URL)
deno task build:npm    # scripts/build-npm.ts (dnt npm build)
```

`fsmlet` has no CLI/task (see its own section below): `runFsmlet`/`startFsmlet`
(`src/fsmlet/fsmlet.ts`) are embedded directly. `test-cli-sdk.ts` at the package
root runs one against `test-apps/debug-only`'s registry for debugging.

Deno version is managed by `.prototools`: `proto install deno --pin local`.
`README.md` is the npm/npx-consumer-facing document (published to `dist/` — see
below); keep source-only detail here instead of there.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt`, not `deno pack`
(used for this repo's other npm-published packages). It's library-only now (one
entry point, `src/index.ts`, no bins), but stays on dnt to map `@pgfsm/db` and
`@pgfsm/logging` to real npm dependencies and declare `@types/pg`.
`.github/workflows/npm-publish.yml` builds this package's `sync-worker` matrix
entry through the dnt path.

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

**Previously known issue, now resolved**: `deno task build:npm` used to fail its
type-check pass with `TS2345` errors in `src/fsmlet/fsmlet.ts` around
`asyncActors` (`ActorReference[]` vs. dnt's bundled `AsyncActor[]`,
`asyncOperationVersion` being `string | undefined` vs. `string`). Verified clean
as of #266 — the mismatch is gone, likely fixed incidentally by #234/#235's
async-operation identity param rename. If it resurfaces, that TS2345 shape is
where to look first.

## Structure (`src/`)

- `fsmlet/` — node-agent implementation for FSM workers (no CLI entry point —
  see its own section below)
- `logger.ts` — composition-root LogTape config (`configureWorkerLogger`) for a
  process embedding this library

## `fsmlet` is driven directly by the compiled `SYNC_OPERATION_REGISTRATIONS` aggregate; no discovery/validation, no CLI for now (#340)

`fsmlet.ts` runs no discovery/validation/DB-load pass at startup any more — no
`@pgfsm/compiler` `validateSyncOperationFromFsmJson`/
`validateSyncOperationFromFolders` (an intermediate
`fsmlet/sync-operation-registrations.ts` module briefly replaced these with a
dynamic-import-based `discoverVerifiedFsmModules` helper; that module has since
been removed too — see below), no `checkRegistryForAsyncActors`/
`checkRegistryAndWorkingForAsyncActors` async-actor-registry verification
(`asyncOperationVerificationMode` is assumed `"none"` for now — a project's FSMs
and their actors are trusted once compiled), and no `loadFsmFromJson` call —
FSMs are loaded by a separate deploy step, `pgfsmctl fsm load` (SPEC-006). What
it does do (SPEC-006, see the next section) is check, read-only, that they were.

Instead, `fsmlet.ts` statically imports the compiler-generated aggregate
registry directly:

```ts
import { SYNC_OPERATION_REGISTRATIONS } from "../../../../test-apps/debug-only/sync-worker/typescript/aggregate-generated-sync-operation-registry.ts";
```

(`SYNC_OPERATION_REGISTRATIONS: SyncOperationRegistration[]` — see
fsm-compiler-ts #338; the import path is a hardcoded relative reference into
`test-apps/debug-only/`'s generated output (#405; `apps/sync-worker/` before) —
there's no per-project config for this yet) and derives everything from it:

- `startFsmlet` builds `registeredFsmModules` (`{fsm_name, fsm_version}[]`,
  deduped from every `SYNC_OPERATION_REGISTRATIONS` entry) and passes it
  straight to `registerFsmlet` — that's the _first_ real step now, replacing the
  old discover → verify-async-actors → load-into-db → register sequence.
- `processNextWork` (`fsmlet.ts`) filters `SYNC_OPERATION_REGISTRATIONS` by the
  claimed dispatch entry's own `fsm_name`/`fsm_version` and passes that
  sub-array into `startFSMWorkerWithDBLock`.
- `startFSMWorkerWithDBLock`/`startFSMWorker` (`fsmworker.ts`) take that
  sub-array as a required
  `syncOperationRegistrations: SyncOperationRegistration[]` parameter and thread
  it straight through to `macrostepV2` (`fsmworker-helper.ts`) — no loading or
  filtering of their own any more (the now-removed
  `sync-operation-registrations.ts`'s `loadAllSyncOperationRegistrations`/
  `syncOperationRegistrationsFor` used to do this inside `fsmworker.ts` itself).
  `macrostepV2`/`runActionImplementation` resolve a handler by
  `syncOperationType` + `syncOperationName` from that sub-array (see
  `findSyncOperationHandler`) instead of indexing into a
  `{actions, guards, delays}` map — `FsmModuleDefinition` (that old map type) is
  gone, replaced by `SyncOperationRegistration` in the public export surface
  (`index.ts`).
- `FsmletHandle.verifiedFsmWithAsyncOps: FsmPluginValidationResult[]`
  (`type.ts`) is renamed `registeredFsmModules: FsmModule[]` — there's no more
  verification producing a `FsmPluginValidationResult`, just the plain
  `{fsm_name, fsm_version}` pairs `registerFsmlet` itself expects.

**No CLI for now**: `src/cli/fsmlet.ts` and its `fsmlet-invocation.ts`/
`.node.ts` helpers are removed, along with `deno.json`'s `fsmlet` task and
`scripts/build-npm.ts`'s `fsmlet` bin registration/mapping entry — the old
`--fsm-folder-path`/`--fsm-name`/`--fsm-version` flags drove the
discovery/validation flow above, which no longer exists, so there was no
meaningful per-invocation flag surface left for a CLI to expose. The library
implementation (`runFsmlet`/`startFsmlet`, `src/fsmlet/fsmlet.ts`) is untouched
and still exported from `index.ts` — embed it directly in your own process
instead of shelling out to a CLI.

## Startup FSM definition check (SPEC-006)

Before `registerFsmlet`, `startFsmlet` calls `checkFsmDefinitions`
(`src/fsmlet/fsm-definition-check.ts`): one `@pgfsm/db`
`getFsmJsonForFsmModules` read for every served `{fsm_name, fsm_version}`,
classified by `classifyFsmDefinitions` as `missing`, `ambiguous` (several rows
with different content, from loads that raced before the unique constraint),
`drifted` (the loaded JSONB's `fsmJsonDigest` differs from the compiled
`FSM_DEFINITIONS` digest) or `undigested` (no digest given for a served module).
Any problem throws one `FsmDefinitionCheckError` listing them all, after ending
the pool, so the fsmlet never registers and the scheduler never routes work to
it.

- `fsmDefinitions` is `startFsmlet`/`runFsmlet`'s required third argument
  (#422), after the registrations it's checked against. For JavaScript callers,
  and 0.2-style calls that pass options third, `startFsmlet` also throws a
  `TypeError` before creating the pool.
- The check is mandatory: no existence-only mode, no opt-out flag. A false
  refusal can only be fixed with a release.
- It runs once per start, never per dispatch: definitions are immutable per
  version, so a passing check stays valid for the process's lifetime.
- Async actors are deliberately not checked here; see SPEC-008.

Tests: `test/fsm-definition-check.test.ts` (unit tests for the classifier;
`startFsmlet` refusal/drift/happy-path tests run only with `DATABASE_URL`).
