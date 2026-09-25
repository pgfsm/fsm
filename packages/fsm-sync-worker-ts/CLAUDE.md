# CLAUDE.md — Worker Fleet (`packages/fsm-sync-worker-ts/`)

Scoped guidance for `@pgfsm/sync-worker`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

The out-of-band worker fleet that drives FSM instances forward (see root
`CLAUDE.md` point 3 — the API never owns worker lifecycle). Kubernetes-style
split: `fsmlet` (kubelet — long-running node agent) is routed work by
`fsmscheduler` (kube-scheduler — control plane, run once per cluster), driven
one-shot by `fsmctl`. `pgcron` is a one-shot deploy-time script that
(re)registers the `pg_cron` job driving `fsm_core.schedule_all_pending()` on a
timer (see spec-003-pgcron-fsm-scheduler.md) — needed because that job
registration is a data-level side effect migra's schema diff can't capture into
a migration script.

The equivalent trio for promise/callback-based async operations
(`async-operation-workerlet`, `async-operation-scheduler`,
`async-operation-ctl`) lives in the sibling package
`packages/fsm-async-worker-ts/` — see its `CLAUDE.md`.

Full CLI reference (flags, defaults, examples) lives in
`docs/guides/CLI-USAGE.md` — read it before invoking any of these directly.

## Commands

```bash
deno task fsmscheduler # control-plane router (run once per cluster)
deno task cli          # fsmctl — one-shot create/resume/send/stop
deno task pgcron       # one-shot: (re)register the pg_cron drain job
deno task check        # deno check src/index.ts
deno task build:npm    # scripts/build-npm.ts (dnt npm build)
```

`fsmlet` has no CLI/task for now (removed — see its own section below);
`runFsmlet`/`startFsmlet` (`src/fsmlet/fsmlet.ts`) are still there to embed
directly.

Deno version is managed by `.prototools`: `proto install deno --pin local`.
`README.md` is the npm/npx-consumer-facing document (published to `dist/` — see
below); keep source-only detail here instead of there.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt`, not `deno pack`
(used for this repo's other npm-published packages) — see
`packages/fsm-compiler-ts/CLAUDE.md`'s "npm publish" section for why dnt is
required to ship CLI `bin` entries. Registers the library export alongside three
shebanged bins (`fsmscheduler`, `fsmctl`, `pgcron`) in one pass — `fsmlet` is
not among them for now (see its own section below).
`.github/workflows/npm-publish.yml` builds this package's `sync-worker` matrix
entry through the dnt path.

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

**Multi-bin `npx` gotcha**: because this package registers three bins and none
of them is named `sync-worker` (the derived executable name from the package
name), a plain `npx @pgfsm/sync-worker fsmscheduler ...` does **not** work — npm
can't determine which bin to run and errors
`could not determine
executable to run` (verified empirically against a scratch
multi-bin package). The correct form is
`npx -p @pgfsm/sync-worker -- fsmscheduler ...` (or a real install, after which
each bin is callable directly) — see `README.md`'s Install section, which
documents this.

**Previously known issue, now resolved**: `deno task build:npm` used to fail its
type-check pass with `TS2345` errors in `src/fsmlet/fsmlet.ts` around
`asyncActors` (`ActorReference[]` vs. dnt's bundled `AsyncActor[]`,
`asyncOperationVersion` being `string | undefined` vs. `string`). Verified clean
as of #266 — the mismatch is gone, likely fixed incidentally by #234/#235's
async-operation identity param rename. If it resurfaces, that TS2345 shape is
where to look first.

## Structure (`src/`)

- `cli/` — three CLI entry points (`fsmscheduler.ts`, `fsmctl.ts`, `pgcron.ts`)
- `fsmlet/` — node-agent implementation for FSM workers (no CLI entry point for
  now — see its own section below)
- `fsmscheduler/` — control-plane routing implementation
- `logger.ts` — composition-root LogTape config for this process

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
FSMs must already be loaded into the database by whatever separately ran that
step.

Instead, `fsmlet.ts` statically imports the compiler-generated aggregate
registry directly:

```ts
import { SYNC_OPERATION_REGISTRATIONS } from "../../../../apps/sync-worker/typescript/aggregate-generated-sync-operation-registry.ts";
```

(`SYNC_OPERATION_REGISTRATIONS: SyncOperationRegistration[]` — see
fsm-compiler-ts #338; the import path is a hardcoded relative reference into
`apps/fsm-core-example`'s own generated output — there's no per-project config
for this yet) and derives everything from it:

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
