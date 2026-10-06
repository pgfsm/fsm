# SPEC-006: FSM Definition Loading as a Deploy Step, Checked at fsmlet Startup

| Field   | Value                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Accepted                                                                                                                                                                            |
| Date    | 2026-09-29                                                                                                                                                                          |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                            |
| Issue   | #417                                                                                                                                                                                |
| Affects | `packages/fsm-sync-worker-ts`, `packages/fsm-ctl-ts`, `packages/fsm-core-db-ts`, `packages/fsm-compiler-ts`, `packages/fsm-cli-ts`, `packages/database-src`, `test-apps/debug-only` |

---

## Problem

The sync worker (`fsmlet`) can't do anything for an FSM version whose definition
isn't in `fsm_core.fsm_json`. Since #340 it doesn't load definitions itself:
`startFsmlet` builds `registeredFsmModules` from the compiled
`SYNC_OPERATION_REGISTRATIONS` and goes straight to `registerFsmlet`
(`packages/fsm-sync-worker-ts/src/fsmlet/fsmlet.ts:130`). That's the right
split, but it leaves three gaps:

1. **A missing definition is silent.** `registerFsmlet` succeeds whether or not
   the FSM exists. `create_instance` then raises
   `FSM with name % and version % not found in fsm_core.fsm_json`, so no
   dispatch entries ever reach the fsmlet. It sits registered and idle, and
   nothing points at the real cause.
2. **Drift is invisible.** A worker compiled from one `fsm.json` can run against
   a DB holding a different definition under the same `fsm_name`/`fsm_version`,
   for example after a local edit without a version bump, or a DB loaded from
   another branch. Handlers resolve by `syncOperationName`
   (`findSyncOperationHandler`), so the mismatch surfaces as a missing handler
   mid-macrostep, or worse, as the wrong behavior with no error.
3. **Loading has no clear owner and isn't safe as a deploy step.** It lives in
   the compiler CLI (`-c load`, `packages/fsm-compiler-ts/src/cli/index.ts`) and
   `loadFsmJSONFromFolders` (`packages/fsm-compiler-ts/src/load-fsm-json.ts`),
   which:
   - catches every per-FSM error, logs it, then logs "Successfully loaded" and
     **exits 0**;
   - walks folders in `readDir` order, so a parent whose `invoke` names a child
     FSM fails (`Child FSM not found in fsm_core.fsm_states`) when the child
     sorts later;
   - loads each FSM in its own statement with no surrounding transaction, so a
     failure leaves a partial load;
   - can race. `load_fsm_from_json_v2` checks whether the version exists and
     then inserts, with no lock. `fsm_core.fsm_json` has **no unique
     constraint** on `(fsm_name, fsm_version)`
     (`packages/database-src/supabase/schemas/11_ext_base/20241219134646_fsm_table.sql`),
     and the transitions insert has no `ON CONFLICT`. Two concurrent loads of
     the same new version can both insert and leave duplicate rows.

The generated project (`@pgfsm/cli create`) has scripts for the scheduler
(`db:pgcron`) and the gateway, but none for loading, so "load before running
workers" is tribal knowledge.

## Constraints

- **SPEC-005 (CLI consolidation).** `@pgfsm/sync-worker` is library-only, with
  no bins. Ops commands that act on the database belong in `@pgfsm/ctl`
  (`pgfsmctl`). Every `pgfsmctl` command needs a database and none needs a pgfsm
  project, so the load command takes an explicit folder path rather than
  discovering a project.
- **Connection minimization** (root `CLAUDE.md` #4, ADR-003). The startup check
  must use the fsmlet's existing pool: one query, no extra connection.
- **ADR-002 (bounded fleet).** The fsmlet runs as N identical replicas. Anything
  it does at startup happens N times on every rollout and restart.
- **Definitions are immutable per version.** `load_fsm_from_json_v2` already
  refuses different content for an existing `fsm_name`/`fsm_version`
  (`already
  loaded with different JSON content`) and returns `cached: true`
  for identical content. This spec relies on that: a check that passes at
  startup stays valid for the life of the process.
- **Generated code goes through Eta templates**, with do-not-edit headers.
  `run-sync-worker.ts` is scaffolded once and then user-owned
  (`--overwrite generated-only` never rewrites it), so existing projects won't
  pick up changes to it automatically.
- **Schema changes follow `docs/schema-change-propagation.md`**: the unique
  constraint and the locking change in `load_fsm_from_json_v2` regenerate types
  through the usual chain.
- **`fsm_json` is JSONB.** Postgres normalizes key order and whitespace, so a
  hash of the raw file bytes never matches the stored value. Any digest has to
  be over a canonical form.

No accepted ADR conflicts with this spec.

## Options considered

### Option A — Do nothing

Loading stays a manual compiler command, and the fsmlet keeps registering blind.

- **Pros:** no work.
- **Cons:** all three problems stay. The "idle worker, no error" failure is the
  most expensive kind to debug, and it hits every new user of a generated
  project.

### Option B — The fsmlet loads definitions on startup

Put `loadFsmFromJson` back into `startFsmlet`, before `registerFsmlet`.

- **Pros:** "start the worker" is the only step, and the worker can never run
  without its definition.
- **Cons:**
  - N replicas write the same rows on every boot.
  - First boots against a fresh DB race into duplicate rows (see Problem 3).
  - A content conflict (edited `fsm.json`, same version) crash-loops the whole
    fleet instead of failing one deploy step.
  - The sync worker doesn't own the `fsm.json`. One definition spans actors in
    TS, Python, Rust and Go, and this undoes the #340 separation.
  - It needs the worker process to have the raw `fsm.json` files at runtime,
    which it doesn't today (it has compiled registries only).

### Option C — External loader, read-only check in the fsmlet (chosen)

Loading becomes an explicit, safe deploy step (`pgfsmctl fsm load`). The fsmlet
only reads: at startup it verifies that every FSM version it serves is loaded
and that the DB content matches what it was compiled from, and refuses to start
otherwise.

- **Pros:**
  - Writes happen once per deploy, in one place, under a lock.
  - The worker fails loudly with the exact fix.
  - Drift is caught before any instance runs.
  - It fits SPEC-005's package boundaries.
- **Cons:**
  - Deploys need an ordering: load, then workers. Workers started first restart
    until the load has run.
  - The compiler, `@pgfsm/db`, ctl, cli and the sync worker all change.

Within Option C, the drift check could take several forms:

| Variant                                                                                     | Verdict                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1: existence check only                                                                    | Rejected. It misses drift, the more dangerous failure.                                                                                                                                      |
| **C2: compiler embeds a canonical digest; the fsmlet reads `fsm_json` and hashes it in TS** | **Chosen.** No schema change for the digest itself. The same query serves both checks. One shared digest function is used by both sides.                                                    |
| C3: store the digest in a new `fsm_json` column at load time                                | Rejected for now. It needs a column plus a backfill, and it trusts every loader (including SQL callers) to compute the digest identically. Worth revisiting if the startup read gets large. |
| C4: embed the full `fsm.json` in the registry and compare structurally                      | Rejected. It bloats the generated code for no gain over a digest.                                                                                                                           |

## Decision

**Option C, with variant C2 for drift.** The deciding drivers:

1. **Loading is a write that must happen exactly once per version**, like a
   migration. A bounded fleet of N replicas is the wrong place for it, and a
   single deploy step with a lock is the right one.
2. **Definitions are immutable per version**, so a startup check is enough. It
   can't go stale during the process's lifetime, which is exactly what makes a
   fail-fast check correct here. (Async actors, by contrast, come and go at
   runtime, which is why they're out of scope; see below.)
3. **Failing at startup with the fix in the message** beats "idle, no error" and
   beats "wrong handler mid-macrostep".

### D1 — Shared canonical digest (`@pgfsm/db`)

- `@pgfsm/db` exports `fsmJsonDigest(json: Json): string`, which returns the
  lowercase hex SHA-256 of the RFC 8785 (JCS) canonical serialization of the
  value. Both the compiler and the fsmlet depend on `@pgfsm/db`, so one
  implementation serves both sides.
- Both sides hash a value that has been through `JSON.parse`: the compiler
  hashes the parsed `fsm.json` file, and the fsmlet hashes the parsed JSONB from
  `pg`. So JSONB's key reordering and whitespace normalization don't matter.

### D2 — Compiler emits definition digests

- Each per-FSM `sync-operation-registry.generated.ts` also exports
  `FSM_DEFINITION: FsmDefinitionDigest` =
  `{ fsmName, fsmVersion, fsmJsonSha256 }`. It's computed from that version's
  `fsm.json` at generate time, via the `sync-operation-registry.eta` template.
- `sync-operation-registry-aggregate.generated.ts` also exports
  `FSM_DEFINITIONS: FsmDefinitionDigest[]`, via
  `sync-operation-registry-aggregate.eta`.
- The `run-sync-worker.ts` scaffold passes `FSM_DEFINITIONS` into `runFsmlet`
  (see D3).

### D3 — fsmlet startup check (`@pgfsm/sync-worker`)

In `startFsmlet`, after the pool connects and **before** `registerFsmlet`:

- One read-only query, through a new `@pgfsm/db` helper, fetches `fsm_name`,
  `fsm_version` and `fsm_json` from `fsm_core.fsm_json` for every entry in
  `registeredFsmModules`.
- Each module is classified as:
  - **ok**: exactly one distinct content, and its digest matches;
  - **missing**: no row;
  - **ambiguous**: more than one row with different content (leftovers from the
    race in Problem 3);
  - **drifted**: the digest differs from the compiled `fsmJsonSha256`;
  - **undigested**: no compiled digest was given for it, so drift can't be ruled
    out.
- If anything isn't `ok`, `startFsmlet` throws **one** error that lists every
  failing module with its reason and ends with the fix
  (`run pgfsmctl fsm load <fsm-folder> against this database`). The fsmlet never
  registers in that case, so the scheduler never routes work to it.
- `fsmDefinitions: FsmDefinitionDigest[]` is a **required third argument** of
  `startFsmlet`/`runFsmlet`, right after the registrations it's checked against:
  `runFsmlet(dbConfig, SYNC_OPERATION_REGISTRATIONS, FSM_DEFINITIONS,
  options?)`.
  `startFsmlet` also throws a `TypeError` before connecting when it isn't an
  array (JavaScript callers, or a 0.2-style call passing options third). Amended
  in #422, see Implementation.
- The check is **mandatory**: there is no existence-only mode and no opt-out.
  Either would let a worker run against a different `fsm.json` than it was built
  from, the failure this spec exists to stop.
- The check runs once per process start and never per dispatch (see driver 2).

### D4 — `pgfsmctl fsm load <folder>` (`@pgfsm/ctl` + `@pgfsm/db`)

- **Command (ctl):** `pgfsmctl fsm load <folder> [--db-url]`. It discovers
  `<folder>/<fsmName>/<version>/fsm.json` using the same layout rules as today
  (`isVersionFolderName`), and accepts relative paths including `./fsm`. It
  prints one line per FSM (`loaded` / `unchanged` / failure reason) and exits
  non-zero if anything failed.
- **Core (`@pgfsm/db`):** `loadFsmDefinitions(deps, definitions[])` takes
  already-parsed definitions, so it has no filesystem access and stays
  runtime-agnostic. It:
  1. derives each definition's dependent children (invoke actors with
     `asyncOperationType === "fsm"`). The small ref-extraction helper this needs
     moves down from `@pgfsm/compiler`'s `util.ts` into `@pgfsm/db`, so ctl
     doesn't take a dependency on the compiler;
  2. **validates before writing**: rejects dependency cycles, and rejects a
     child that is neither in the batch nor already in the DB;
  3. **orders children before parents** (topological sort);
  4. loads the whole batch in **one transaction**, calling
     `load_fsm_from_json_v2` per definition. Any failure rolls back everything.
     Re-running with identical content succeeds as a no-op (`cached`).
- **Concurrency (`database-src`):**
  - `load_fsm_from_json_v2` takes
    `pg_advisory_xact_lock(hashtextextended(input_fsm_name || '.' || input_fsm_version, 0))`
    before its existence check, so concurrent callers of the same version
    serialize, whoever they are.
  - A `UNIQUE (fsm_name, fsm_version)` constraint on `fsm_core.fsm_json` is the
    backstop. Its migration aborts with a clear message if duplicate rows with
    _different_ content already exist, and deletes exact duplicates.
- **Compiler (`-c load`)** is deprecated for one minor release: it warns with
  the replacement `pgfsmctl fsm load` command and calls `@pgfsm/db`'s
  `loadFsmDefinitions`, so it gets the same fixes. It's removed in the release
  after that.
- **Generated project (`@pgfsm/cli`):** `create` adds
  `"db:load": "npx -y @pgfsm/ctl@<ver> fsm load fsm"` to `package.json`, next to
  `db:pgcron`. The README it writes documents the deploy order (`db:load` →
  `db:pgcron` → workers). `test-apps/debug-only` is regenerated to match.

### Out of scope — async actor coverage and liveness

Checking that `fsm.json`'s async actors are implemented, registered or running
**does not belong to the fsmlet**:

- Async actors are separate processes connected through a durable queue. They
  come and go at runtime, so a startup check isn't meaningful for them the way
  it is for immutable definitions.
- The existing `checkRegistryForAsyncActors` /
  `checkRegistryAndWorkingForAsyncActors` read v1 tables that the Activity
  Gateway doesn't maintain.

That work, which covers a build-time implementation-coverage check, a gateway
readiness view, queue-age alerting, and at most a non-fatal fsmlet warning, gets
its **own spec**. It should reference the gateway TCP/scaling spec (PR #394),
because readiness has to aggregate across gateway replicas.

## Consequences & migration

**What gets harder**

- **Deploys have an order**: `db:load` must run before new workers start.
  Workers started first fail fast and restart (a crash-loop under Kubernetes)
  until the load runs. This is intentional and self-healing, but it will show up
  as restart counts during a badly ordered rollout.
- **Editing `fsm.json` now requires a version bump or a DB reset**, even
  locally. The loader already refused changed content under the same version.
  Now the worker refuses too, instead of silently running stale handlers.
- **The startup query reads every served definition's JSONB once per boot.**
  That's fine at current sizes. C3 (a stored digest column) is the upgrade path
  if it ever isn't.

**Migration**

1. `@pgfsm/db`: `fsmJsonDigest`, the definitions-read helper, the ref
   extraction, `loadFsmDefinitions`. Schema: advisory lock plus unique
   constraint, following `docs/schema-change-propagation.md`.
2. `@pgfsm/compiler`: emit `FSM_DEFINITION` / `FSM_DEFINITIONS`; `-c load`
   becomes a deprecated wrapper.
3. `@pgfsm/sync-worker`: the startup check and the new required `fsmDefinitions`
   argument. This is a breaking change (0.2 → 0.3): existing callers must pass
   it, and are told so at startup.
4. `@pgfsm/ctl`: `fsm load`.
5. `@pgfsm/cli`: the `db:load` script, the `run-sync-worker.ts` scaffold passes
   `FSM_DEFINITIONS`, README deploy order. Regenerate `test-apps/debug-only`.

Existing projects add `FSM_DEFINITIONS` to their own `run-sync-worker.ts` by
hand (an import and one argument) before upgrading `@pgfsm/sync-worker`; the
startup `TypeError` and the release notes both say exactly what to add.

**Rollback**

- The fsmlet check has no runtime off switch. If it ever wrongly refuses a
  worker, the fix is a `@pgfsm/sync-worker` patch release, or pinning the
  previous (0.2) release and reverting `run-sync-worker.ts`'s call.
- The `-c load` wrapper stays for a release, so scripts that call it keep
  working.
- The unique constraint and the advisory lock are an ordinary down-migration.
  Removing them restores today's (racy) behavior with no data change.

## Acceptance criteria

- [ ] With an FSM version in the registry but absent from `fsm_core.fsm_json`,
      `startFsmlet` throws before `registerFsmlet`. The error names that
      `fsm_name`/`fsm_version` and the `pgfsmctl fsm load` fix, and no
      `fsm_workerlet` row is written.
- [ ] With several failing modules, the single error lists all of them, each
      with its reason (missing / ambiguous / drifted / undigested).
- [ ] With `fsmDefinitions` passed and the DB `fsm_json` for a served version
      differing from the compiled `fsm.json`, `startFsmlet` throws a `drifted`
      error. Reordering keys or whitespace in `fsm.json` does **not** trigger
      it.
- [ ] `fsmDefinitions` is `startFsmlet`/`runFsmlet`'s required third argument:
      omitting it is a type error, and at runtime `startFsmlet` throws a
      `TypeError` naming `FSM_DEFINITIONS` before opening any connection.
- [ ] A served module with no entry in `fsmDefinitions` is reported
      `undigested`.
- [ ] There is no option that disables the check.
- [ ] The check uses the fsmlet's existing pool and issues exactly one query.
- [ ] The compiler's generated per-FSM registry exports `FSM_DEFINITION` and the
      aggregate exports `FSM_DEFINITIONS`, both from Eta templates. The digest
      equals `fsmJsonDigest(JSON.parse(fsm.json))`.
- [ ] `pgfsmctl fsm load <folder>` exits non-zero when any definition fails, and
      leaves the DB unchanged in that case (one transaction).
- [ ] A folder where a parent FSM sorts before the child it invokes loads
      successfully (children first). A cycle, or a child missing from both the
      folder and the DB, fails before any write.
- [ ] Running `pgfsmctl fsm load` twice with identical content succeeds and
      reports every FSM `unchanged` the second time.
- [ ] Two concurrent `pgfsmctl fsm load` runs of the same new version leave
      exactly one `fsm_core.fsm_json` row per `(fsm_name, fsm_version)`, with no
      duplicate states or transitions.
- [ ] `fsm_core.fsm_json` has a unique constraint on `(fsm_name, fsm_version)`.
      Its migration fails with a clear message on conflicting duplicates and
      removes exact duplicates.
- [ ] Compiler `-c load` logs a deprecation warning that names
      `pgfsmctl fsm load`, and uses the same `loadFsmDefinitions` core.
- [ ] `@pgfsm/cli create` output includes a `db:load` script, a
      `run-sync-worker.ts` that passes `FSM_DEFINITIONS`, and README deploy
      order. `test-apps/debug-only` is regenerated to match.
- [ ] `@pgfsm/ctl` has no dependency on `@pgfsm/compiler`.

## Implementation

Accepted in #418. Implemented in one issue, #421:

- DB: advisory lock in `load_fsm_from_json_v2`,
  `UNIQUE (fsm_name,
  fsm_version)` on `fsm_core.fsm_json` (migration
  `fsm_core--2.0.7--2.0.8`). The lock uses the two-key
  `pg_advisory_xact_lock(hashtext(...), hashtext(...))` form rather than the
  one-key `hashtextextended` form in D4, to stay out of the single-bigint
  advisory key space.
- `@pgfsm/db` `fsm-definition.ts`; `@pgfsm/sync-worker`
  `fsm-definition-check.ts`; compiler `FSM_DEFINITION`/`FSM_DEFINITIONS`;
  `pgfsmctl fsm load`; `@pgfsm/cli` `db:load`.
- D1: `fsmJsonDigest` is async (`Promise<string>`), since it uses Web Crypto.
- D3 amended during review of #422: `fsmDefinitions` is a required third
  argument rather than an optional option with a warning, the
  `skipFsmDefinitionCheck` opt-out is dropped (the check is mandatory), and a
  served module without a digest is a new `undigested` problem.
