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
