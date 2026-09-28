# SPEC-005: CLI Consolidation — `@pgfsm/ctl` (`pgfsmctl`), Library-Only `@pgfsm/sync-worker`, Remove `fsm-devstack-ts`

| Field   | Value                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status  | Draft                                                                                                                                                  |
| Date    | 2026-09-29                                                                                                                                             |
| Authors | Niraj, Claude                                                                                                                                          |
| Issue   | #409                                                                                                                                                   |
| Affects | new `packages/fsm-ctl-ts`, `packages/fsm-sync-worker-ts`, `packages/fsm-devstack-ts` (removed), `packages/fsm-cli-ts`, `test-apps/debug-only`, docs/CI |

---

## Problem

The operational commands a pgfsm user needs are spread across packages that
don't match how they are used, and one package now duplicates another.

1. **`@pgfsm/sync-worker` is a runtime library that also ships three unrelated
   bins.** 0.2.0 publishes `fsmctl` (create/resume/send/stop instances),
   `pgcron` (one-shot `pg_cron` job registration, SPEC-003) and `fsmscheduler`
   (the control-plane router SPEC-003 demoted to a fallback). None of them is
   the worker. The worker itself (`runFsmlet`) has no bin at all: generated
   projects embed it via `run-sync-worker.ts`. So a sync-worker image carries
   ops tooling it never runs, and an ops Job has to install the worker runtime
   to get `pgcron`.
2. **The multi-bin `npx` form is awkward.** No bin is named `sync-worker`, so
   `npx @pgfsm/sync-worker pgcron` fails with "could not determine executable to
   run". Users must type `npx -p @pgfsm/sync-worker -- pgcron`.
3. **`fsm-devstack-ts` (`fsmdev`) overlaps `@pgfsm/cli`.** Step 1 of `fsmdev` is
   `generate-all`, which `pgfsm create`/`add` (SPEC-004) now owns project-aware.
   SPEC-004 left open question #4 ("`fsmdev` convergence") for this.
   `@pgfsm/devstack` was never published to npm.
4. **A generated project can't bring up a full local stack.** `fsmdev` is the
   only thing that registers the pgcron job and starts the Activity Gateway. A
   `pgfsm create` project (e.g. `test-apps/debug-only`) documents only the sync
   and async workers. Async workers can't do anything without a gateway, and
   nothing is scheduled without the pgcron job.

**Why now:** neither `@pgfsm/cli` nor a ctl package is on npm yet (`@pgfsm/cli`,
`@pgfsm/ctl` and unscoped `pgfsm` all return 404). Binary names and package
boundaries are free to choose once. After the first publish, every rename is a
breaking change.

## Constraints

- **Root `CLAUDE.md` #3: workers are out-of-band from the API.** Nothing here
  may make the HTTP tier own worker or gateway lifecycle.
- **Root `CLAUDE.md` #4 / ADR-003 connection accounting: minimize pg Pools.**
  The ctl commands are one-shot and open at most one short-lived Pool.
  `scheduler run` keeps today's fsmscheduler footprint (one LISTEN connection)
  and adds nothing.
- **ADR-002 (Stage 3) and SPEC-003:** `pg_cron` running
  `fsm_core.schedule_all_pending()` is the primary scheduling path.
  `fsmscheduler` is a fallback-only holdover whose deletion SPEC-003 postponed
  until the pg_cron drain has run long enough in production to trust on its own.
  **This spec does not change that decision.** It only moves `fsmscheduler`'s
  home.
- **ADR-003: the Activity Gateway is a per-host sidecar.** Workers reach it over
  a Unix socket (`--sidecar-socket`, default
  `/tmp/pgfsm-activity-gateway-workers.sock`). It contains no user code, so
  generated projects must not own gateway source.
- **SPEC-004:** `pgfsm` is the project-aware scaffolding CLI.
  `pgfsm.config.json` is only a marker. Generated projects pin tool versions
  through `npx -y <pkg>@<version>` npm scripts instead of dependencies.
- **Release mechanics:** each package has its own release flow. At most three
  tags per `git push` (#400).
- **ADR-001 logging:** every bin calls `configureLogging()` once at its entry
  point.
- Pre-1.0. `@pgfsm/sync-worker` has a small user base, so a minor bump may
  remove bins.

## Options considered

### Option A — Status quo plus docs

Keep the bins in `@pgfsm/sync-worker`, keep `fsmdev`, and document
`npx -p @pgfsm/sync-worker -- pgcron` and the gateway command in generated
READMEs.

- **Pros:** No code or package changes.
- **Cons:** Leaves all four problems in place. Worker images still carry ops
  tooling. The npx form stays awkward. `fsmdev` and `pgfsm` still both own
  generation.

### Option B — Fold ops into `@pgfsm/cli` (one `pgfsm` binary)

`pgfsm create|add` plus `pgfsm db pgcron`, `pgfsm instance …`,
`pgfsm scheduler run`. Heavy modules load lazily per subcommand. This matches
the Supabase CLI (`supabase init`/`db push`/`start`) and Prisma CLI
(`prisma init`/`migrate deploy`) model.

- **Pros:** One tool to learn, one package to release, one pin per project.
- **Cons:** Tools with different compatibility axes end up in one version line.
  Scaffolding tracks `@pgfsm/compiler` and the worker SDKs. Ops commands track
  the **DB schema / migration version** through `@pgfsm/db`. An ops Job image
  installs the compiler tree (`xstate`, `eta`, `ajv`, ~1 MB+ unpacked) it never
  runs. Lazy `import()` speeds up startup but doesn't shrink the install. The
  ops commands also don't need a project (`pgfsm.config.json`), so they don't
  fit the "project-aware CLI" identity SPEC-004 set.

### Option C — New `@pgfsm/ctl` package, bin `pgfsmctl` (proposed)

A thin, single-bin CLI on `@pgfsm/db` + `pg` for everything that operates on a
running database: pgcron registration, instance commands, and the fsmscheduler
fallback. `@pgfsm/cli` (`pgfsm`) stays scaffolding-only. `@pgfsm/sync-worker`
becomes library-only. `fsm-devstack-ts` is removed.

- **Pros:** Each package versions along one compatibility axis (cli ↔
  compiler/SDKs, ctl ↔ db/migrations, sync-worker ↔ runtime). Ops Job images
  install only `@pgfsm/db` + `pg`. With a single bin, plain
  `npx @pgfsm/ctl@x pgcron register` works. The naming follows the repo's
  existing Kubernetes analogy (`fsmlet`, `fsmscheduler`, `fsmctl` → `kubectl`)
  and the `*ctl` convention (`kubectl`, `systemctl`, `pg_ctl`).
- **Cons:** One more package to release (tags, README, npm-publish matrix
  entry). Users learn two binaries. Generated projects pin two tool versions.

### Option D — Give `@pgfsm/db` the bins

Ship `pgfsmctl` from `@pgfsm/db`, since the commands are thin wrappers over its
functions.

- **Pros:** No new package. The version is exactly the DB-compat axis.
- **Cons:** It's the same smell this spec removes from sync-worker: a library
  consumed by the API, the workers and the compiler would carry CLI dependencies
  (`@std/cli`, `dotenv`, `@pgfsm/logging` config) and bins every consumer
  installs. It would also need dnt's multi-bin build path.

## Decision

Adopt **Option C**.

**Decision drivers:**

1. **One compatibility axis per package.** This decides it. Whether `pgfsmctl`
   works depends on the `fsm_core.*` functions in the deployed migrations.
   Whether `pgfsm` works depends on the compiler and SDK versions. Coupling the
   two (Option B) means every compiler release bumps the ops tool and every
   DB-function change bumps the scaffolder.
2. **Dev looks like prod.** In Kubernetes, pgcron registration is a Job or init
   container, and instance commands are run by operators or CI. Those pull a
   small `@pgfsm/ctl`, not the scaffolder. The same command runs locally through
   an npm script.
3. **Names are still free.** Nothing is published yet, so no rename cost.

Option A doesn't solve the problem. Option B loses on driver 1. Option D puts
CLI weight on a widely consumed library, the thing this spec is removing.

### Package and binary layout

| Package              | Bin        | Purpose                                              | Versions track                      |
| -------------------- | ---------- | ---------------------------------------------------- | ----------------------------------- |
| `@pgfsm/cli`         | `pgfsm`    | `create`, `add` (later `sync`, #390) — project-aware | `@pgfsm/compiler` + worker SDKs     |
| `@pgfsm/ctl` (new)   | `pgfsmctl` | `pgcron …`, `instance …`, `scheduler run` — DB-level | `@pgfsm/db` + `fsm_core` migrations |
| `@pgfsm/sync-worker` | _(none)_   | `runFsmlet`/`startFsmlet` library + types            | runtime                             |
| `@pgfsm/devstack`    | —          | **removed** (never published)                        | —                                   |

- **`pgfsm` stays the scaffolder.** The product-named command is the first one a
  newcomer types, and that's `create`. `add` runs repeatedly inside a project,
  which rules out the `npm create pgfsm` alternative (it covers only `create`).
- **`pgfsmctl`, not `fsmctl`.** It's namespaced to the product and the `@pgfsm`
  scope. It also avoids two different `fsmctl` binaries on `PATH` while
  `@pgfsm/sync-worker@0.2` (which ships `fsmctl`) is still installed.
- **Source location:** `packages/fsm-ctl-ts/` (Deno, dnt npm build like
  `fsm-cli-ts`), a new root `deno.json` workspace member, and a
  `packages/fsm-ctl-ts/CLAUDE.md`.

### `pgfsmctl` command surface

Noun-then-verb throughout, so each noun has room to grow:

```
pgfsmctl pgcron register [--schedule <cron>]     # was: pgcron  (idempotent)
pgfsmctl pgcron unregister | status              # new, small: cron.unschedule / cron.job lookup
pgfsmctl instance create | resume | send | stop  # was: fsmctl create|resume|send|stop (same flags)
pgfsmctl scheduler run                           # was: fsmscheduler — fallback only (SPEC-003)
```

- Every command takes `-d/--db-url`, falling back to `DATABASE_URL` from `.env`,
  the same as today. None of them requires `pgfsm.config.json`.
- `instance …` stays **DB-direct** (through `@pgfsm/db`), unchanged from today's
  `fsmctl`. Going through the REST API (`fsm-core-ts-hono-deno`), the way
  `kubectl` goes through the apiserver instead of etcd, is recorded as future
  work, not in scope.
- `scheduler run` is the one long-running command. It stays here only as
  SPEC-003's fallback. Deleting it later needs no change to anything else in
  this spec. `--help` labels it "fallback — pg_cron is the primary scheduler".
- Out of scope: `async-operation-worker-gateway-ctl`, the gateway's gRPC debug
  client. It talks to the gateway, not the DB, and stays in
  `@pgfsm/async-worker-gateway`.

### Generated projects (`pgfsm create`)

`create` writes pinned scripts next to `fsm:add`. The gateway is config, not
code: there's no `async-worker-gateway/` directory and no wrapper `.ts`.

```json
{
  "scripts": {
    "fsm:add": "npx -y @pgfsm/cli@<cliVersion> add",
    "db:pgcron": "npx -y @pgfsm/ctl@<ctlVersion> pgcron register",
    "gateway": "npx -y -p @pgfsm/async-worker-gateway@<gatewayVersion> -- async-operation-worker-gateway --ensure-queue-on-register"
  }
}
```

(`@pgfsm/async-worker-gateway` ships two bins, so its script needs the
`-p <pkg> -- <bin>` form.) The generated README's "Run the stack" section lists,
in order: `npm run db:pgcron` (once per database), `npm run gateway`, the sync
worker, then the async workers. Pinned versions are the ones this `@pgfsm/cli`
release was built and tested against, recorded the same way SPEC-004 records
`toolVersion`.

Container images, per-language Dockerfiles and a generated `compose.yaml`
(including sharing the gateway's sidecar socket) are a **follow-up spec**.

## Consequences & migration

**Harder:**

- One more package in the release rotation, with its own README, npm-publish
  matrix entry and tag.
- Users meet two binaries (`pgfsm`, `pgfsmctl`) instead of one.
- `@pgfsm/sync-worker@0.3.0` breaks anyone calling its bins. They switch to
  `npx @pgfsm/ctl …`, and the changelog/README map old to new.

**Easier:**

- Worker images carry only runtime code. Ops images carry only `@pgfsm/db` +
  `pg`.
- Plain `npx @pgfsm/ctl …` works.
- One owner for generation (`pgfsm`). The devstack package and its
  compiler-replicating `generate-all` path (see `fsm-compiler-ts/CLAUDE.md`) go
  away.

**Migration** (each step is its own implementation issue):

1. **Create `@pgfsm/ctl`.** Move `src/cli/{fsmctl,pgcron,fsmscheduler}.ts`,
   their `*-invocation{,.node}.ts` pairs and `src/fsmscheduler/` out of
   `fsm-sync-worker-ts` into `packages/fsm-ctl-ts/`, re-shaped as `pgfsmctl`
   subcommands. Add `pgcron unregister|status`. Add to the root workspace and
   the npm-publish matrix, with the first version at 0.1.0.
2. **Make `@pgfsm/sync-worker` library-only (0.3.0).** Remove the bins from
   `scripts/build-npm.ts` and the `cli`/`fsmscheduler`/`pgcron` deno tasks. Drop
   `runFsmScheduler`/`FsmSchedulerOptions` from `index.ts` (they move to ctl).
   Update README/CLAUDE.md. Hard removal, no stub bins.
3. **Generated project scripts.** `@pgfsm/cli`'s `create` writes the `db:pgcron`
   and `gateway` scripts and the README section. Regenerate
   `test-apps/debug-only`. This depends on step 1 being published.
4. **Remove `fsm-devstack-ts`.** Delete the package and its root `deno.json`
   workspace entry. Update root `CLAUDE.md`, `fsm-compiler-ts/CLAUDE.md` (the
   fsmdev write-root note), the `fsm-cli-ts/scripts/build-npm.ts` comment, and
   the "Dev tooling / CLI orchestration" option in the issue forms and
   `.github/advanced-issue-labeler.yml`. Mark SPEC-004 open question #4 resolved
   by this spec.
5. **Docs and callers.** Update ADR-002/ADR-003 command references (`fsmctl` →
   `pgfsmctl instance`, `fsmscheduler` → `pgfsmctl scheduler run`),
   `packages/fsm-core-db-ts/README.md`, and the fleet journey tests under
   `apps/fsm-core-example/fsm/creditCheck/v01/test-with-async-worker-v{1,2}/`
   and `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts` wherever they
   name or spawn the old bins. Also fix `fsm-sync-worker-ts/CLAUDE.md`'s
   dangling `docs/guides/CLI-USAGE.md` reference.

Steps 1→2→3 are ordered. Step 4 can land any time after step 3. Step 5 goes with
whichever step changes the thing it documents.

**Rollback:**

- Before `@pgfsm/ctl` is published, `git revert` the step PRs.
- After publishing, the old bins are still available at
  `@pgfsm/sync-worker@0.2.0` on npm, so users can pin back. Re-adding the bins
  in a 0.3.x release is mechanical, because the ctl sources are the same modules
  moved.
- `fsm-devstack-ts` was never published, so removing it has no external rollback
  concern.
- No schema or data changes are involved.

## Acceptance criteria

- [ ] `@pgfsm/ctl` exists at `packages/fsm-ctl-ts/`, is a root workspace member,
      and publishes to npm with exactly one bin, `pgfsmctl`.
      `npx @pgfsm/ctl@<v> --help` works without `-p`.
- [ ] `@pgfsm/ctl`'s npm `dependencies` don't include `@pgfsm/compiler`,
      `@pgfsm/sync-worker`, `xstate`, `eta` or `ajv`.
- [ ] `pgfsmctl pgcron register` behaves identically to today's `pgcron`
      (idempotent, same `--schedule`/`--db-url` handling).
      `pgfsmctl pgcron status` reports the registered job and
      `pgfsmctl pgcron unregister` removes it. Both are verified against local
      Supabase with `pg_cron` enabled.
- [ ] `pgfsmctl instance create|resume|send|stop` accepts today's `fsmctl` flags
      and produces the same DB effects, covered by the existing fsmctl tests
      ported to ctl.
- [ ] `pgfsmctl scheduler run` behaves identically to today's `fsmscheduler`,
      and its `--help` marks it as SPEC-003's fallback.
- [ ] Every `pgfsmctl` command works from a directory with no
      `pgfsm.config.json`, taking the DB from `--db-url` or `DATABASE_URL`.
- [ ] `@pgfsm/sync-worker@0.3.0` publishes no `bin` entries. Its `index.ts`
      still exports `runFsmlet`/`startFsmlet`, and a regenerated
      `test-apps/debug-only` sync worker runs unchanged.
- [ ] `pgfsm create` writes pinned `db:pgcron` and `gateway` npm scripts and a
      README "Run the stack" section in the order pgcron → gateway → sync worker
      → async workers. `test-apps/debug-only` is regenerated with them.
- [ ] Following the regenerated `test-apps/debug-only` README end to end
      (`db:pgcron`, `gateway`, sync worker, the TypeScript async worker) drives
      an instance of an example FSM through an async actor to a final state,
      with no `fsmdev`.
- [ ] `packages/fsm-devstack-ts/` is gone, and
      `grep -rE "fsm-devstack|@pgfsm/devstack|fsmdev"` outside `docs/specs/`
      returns nothing.
- [ ] No repo file outside `docs/specs/` and changelogs invokes the old
      `fsmctl`/`pgcron`/`fsmscheduler` bins or
      `deno task cli|pgcron|fsmscheduler` in `fsm-sync-worker-ts`.
- [ ] SPEC-004 open question #4 links to this spec as its resolution.
      ADR-002/ADR-003 name `pgfsmctl` where they named `fsmctl`/`fsmscheduler`.

## Open questions (for review)

1. **Reserve unscoped `pgfsm` on npm?** A placeholder would block squatting and
   allow `npx pgfsm create` later. Publishing is outward-facing, so it's the
   maintainer's call.
2. **Version pins in generated scripts:** hard-code the tested versions at
   `@pgfsm/cli` build time (proposed), or resolve `latest` at `create` time?
   Build-time pins are reproducible but go stale until `pgfsm upgrade` exists.
3. **`scheduler run` deletion trigger:** SPEC-003 leaves this undefined. Should
   this spec set a concrete criterion (e.g. N weeks of pg_cron-only operation
   with `cron.job_run_details` clean), or leave it to a later decision?

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
