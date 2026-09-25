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
deno task fsmlet       # node agent — claims & drives FSM workers
deno task fsmscheduler # control-plane router (run once per cluster)
deno task cli          # fsmctl — one-shot create/resume/send/stop
deno task pgcron       # one-shot: (re)register the pg_cron drain job
deno task check        # deno check src/index.ts
deno task build:npm    # scripts/build-npm.ts (dnt npm build)
```

Deno version is managed by `.prototools`: `proto install deno --pin local`.
`README.md` is the npm/npx-consumer-facing document (published to `dist/` — see
below); keep source-only detail here instead of there.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt`, not `deno pack`
(used for this repo's other npm-published packages) — see
`packages/fsm-compiler-ts/CLAUDE.md`'s "npm publish" section for why dnt is
required to ship CLI `bin` entries. Registers the library export alongside four
shebanged bins (`fsmlet`, `fsmscheduler`, `fsmctl`, `pgcron`) in one pass.
`.github/workflows/npm-publish.yml` builds this package's `sync-worker` matrix
entry through the dnt path.

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

**Multi-bin `npx` gotcha**: because this package registers four bins and none of
them is named `sync-worker` (the derived executable name from the package name),
a plain `npx @pgfsm/sync-worker fsmlet ...` does **not** work — npm can't
determine which bin to run and errors `could not determine executable
to run`
(verified empirically against a scratch multi-bin package). The correct form is
`npx -p @pgfsm/sync-worker -- fsmlet ...` (or a real install, after which each
bin is callable directly) — see `README.md`'s Install section, which documents
this.

**Previously known issue, now resolved**: `deno task build:npm` used to fail its
type-check pass with `TS2345` errors in `src/fsmlet/fsmlet.ts` around
`asyncActors` (`ActorReference[]` vs. dnt's bundled `AsyncActor[]`,
`asyncOperationVersion` being `string | undefined` vs. `string`). Verified clean
as of #266 — the mismatch is gone, likely fixed incidentally by #234/#235's
async-operation identity param rename. If it resurfaces, that TS2345 shape is
where to look first.

## Structure (`src/`)

- `cli/` — four CLI entry points (`fsmlet.ts`, `fsmscheduler.ts`, `fsmctl.ts`,
  `pgcron.ts`)
- `fsmlet/` — node-agent implementation for FSM workers
- `fsmscheduler/` — control-plane routing implementation
- `logger.ts` — composition-root LogTape config for this process

## Workers are driven by the compiled `SYNC_OPERATION_REGISTRATIONS` aggregate, not per-instance validation (#340)

`fsmlet.ts`'s startup no longer calls `@pgfsm/compiler`'s
`validateSyncOperationFromFsmJson`/`validateSyncOperationFromFolders`, and
`fsmworker.ts`'s `startFSMWorkerWithDBLock` no longer calls
`validateSyncOperationFromFolder` or dynamically `import()`s each
`<fsmName>/<fsmVersion>`'s own `actions|guards|delays/index.ts` (nor
`async-worker/.../actors/index.ts` — that field was write-only, never actually
consumed downstream). Both were re-validating/re-resolving sync-operation
modules per fsmlet startup or per dispatched instance, duplicating work the
compiler already does at generate-time.

Both now go through `fsmlet/sync-operation-registrations.ts`, which dynamically
imports the compiler-generated
`sync-worker/typescript/aggregate-generated-sync-operation-registry.ts`
(`SYNC_OPERATION_REGISTRATIONS: SyncOperationRegistration[]` — see
fsm-compiler-ts #338) once per call site and trusts it: any
`<fsmName>/<fsmVersion>` present there, with a readable `fsm.json` copy
alongside it, is considered verified — the compiler is what guarantees the
registered handlers actually exist, not this process (deliberately no
re-validation via dynamic import, and no AJV schema check either, now that this
package only ever consumes already-compiled output).

- `discoverVerifiedFsmModules({ mode: "all" | "single", ... })` replaces
  `fsmlet.ts`'s step 1 (still returns `FsmPluginValidationResult[]`, the
  `@pgfsm/compiler` type the rest of `fsmlet.ts` already threads through
  `loadFsmFromJson`/`checkRegistryForAsyncActors`/`registerFsmlet`, to keep
  those downstream steps unchanged — `fsmAbsFolderPath`/`fsmModuleDefinition`/
  `failedMethods` are now best-effort placeholders, no longer meaningful once
  module resolution and validation both live in the compiler).
- `loadAllSyncOperationRegistrations()` + `syncOperationRegistrationsFor(...)`
  replace `fsmworker.ts`'s per-instance dynamic-import branch:
  `startFSMWorkerWithDBLock` loads the aggregate once, filters it down to the
  dispatched instance's own `<fsmName>/<fsmVersion>` sub-array, and threads that
  sub-array — not a pre-grouped `{actions, guards, delays}` map — through
  `startFSMWorker` into `macrostepV2` (`fsmworker-helper.ts`).
  `macrostepV2`/`runActionImplementation` resolve a handler by
  `syncOperationType` + `syncOperationName` from that sub-array (see
  `findSyncOperationHandler`) instead of indexing into a map.
- `FsmModuleDefinition` (the old `{actions, guards, delays, actors}` map type)
  is gone — replaced by `SyncOperationRegistration` (mirrors the compiler's own
  generated type) in the public export surface (`index.ts`).
- `startFSMWorkerWithDBLock`'s `verifiedModule`/`validatePlugin` params are gone
  (nothing else read them once the dynamic-import branch was removed); its only
  remaining identity params are `fsm_name`/`fsm_version`.
