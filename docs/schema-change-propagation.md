# Schema Change Propagation

`packages/database-src/` is the source of truth for both the FSM JSON schema
(`fsm.machine.schema.v3.json`) and the PostgreSQL schema (`supabase/schemas/`).
Most other packages consume types generated from one or the other. Editing
either has to propagate through a specific chain — skipping a step doesn't fail
loudly, it just leaves a downstream package's hand-written type silently out of
sync with what the schema actually says. This doc is the map; see each linked
package's own `CLAUDE.md` for the exact commands.

## A. Editing `fsm.machine.schema.v3.json`

1. **Regenerate both generated-type outputs**, from `packages/database-src/` (or
   the equivalent `deno task` from `packages/fsm-compiler-ts/` — both resolve to
   the same script, see that package's `CLAUDE.md`):
   - `npm run generate:fsm-types` — rewrites
     `packages/database-src/generated/fsm-machine-schema.types.ts`
   - `npm run generate:pg-types` — rewrites
     `packages/database-src/supabase/schemas/10_ext_helper/fsm_core_enums.generated.sql`
     and `.../fsm_core_json_schema.generated.sql` (the latter is
     `fsm_core.fsm_json_schema()`, returning the whole schema as JSON)

   Never hand-edit either generated file.
2. **Review `packages/fsm-compiler-ts/src/types/index.ts`.** Every hand-written
   type there that's meant to be schema-derived (see that directory's
   `README.md` audit table) picks up the change automatically via an
   `InvokeObject`/`TransitionObject`/`InitialTransitionObject`/etc.
   indexed-access type (`Extract`/`Exclude`/`Omit`/`Partial` over it). Anything
   still hand-written as a literal union needs a manual look — that's exactly
   what the audit table exists to track.
3. **Verify `fsm-compiler-ts`**: `deno fmt`, then
   `deno check src/index.ts src/cli/index.ts test/*.ts`, then
   `deno test --allow-all test/`, then `deno task build:npm 0.0.0-test` (remove
   `dist/` after) to confirm the npm-publish path still resolves the
   cross-package type import cleanly (see that package's `CLAUDE.md`'s "npm
   publish" section for why this step exists).
4. If `generate:pg-types` produced a new/changed enum, the generated SQL under
   `10_ext_helper/` is picked up the next time the flow in section B below runs
   — it's just another schema file at that point.

## B. Editing a SQL file under `packages/database-src/supabase/schemas/`

1. **Regenerate the migration + DB types**, from `packages/database-src/`:
   `npm run supabase:restart:with:diff:withUpgradeScript:<patch|minor|major>`
   (or `scripts/supabase-restart-with-diff.ts` directly). This restarts the
   local Supabase instance, diffs the declarative schema into a new file under
   `supabase/migrations/`, and regenerates
   `packages/database-src/generated/database.types.ts`.

   **Shared-service caveat**: only one worktree can run local Supabase at a time
   — coordinate before running this (see `AGENTS.md`'s worktree note).
2. **Update `packages/fsm-core-db-ts/`** — the direct consumer of
   `database.types.ts`. Grep the changed function/table name in
   `packages/database-src/generated/database.types.ts` to find its
   `Args`/`Row`/`Returns` shape, then review every TS wrapper function whose
   parameter/return types touch it. Follow that package's `CLAUDE.md` for the
   PG→TS naming rules (strip `_v1`/`_v2`, camelCase, `input_*` param prefix).
   **No automated `deno check`/test task exists for this package today** — it
   only has a `dev` task (`deno.json`); verify by hand or via whichever
   downstream package's own check/test catches the mismatch.
3. **Review `packages/fsm-compiler-ts/`** only if the change affects a type it
   imports from `database.types.ts` via `@pgfsm/db/database.types` — most
   changes here won't touch it, since `fsm-compiler-ts` is schema-JSON-facing,
   not DB-facing, except at a few boundaries (`Json`).
4. **Review `packages/fsm-sync-worker-ts/`** once `fsm-core-db-ts` (and/or
   `fsm-compiler-ts`) are updated. Anything there deriving a hand-written type
   from a DB-generated `Args`/`Row`/`Returns` type (e.g. `MacrostepV2Result` ←
   `archive_event_from_fsm_type_worker_v2`'s `Args`, or `FsmTransitionRow` ←
   `fsm_transitions`' `Row`) needs its field names/types re-checked against the
   new generated shape — field names can drift independently of types (see
   `MacrostepV2Result`'s history: its keys had silently diverged from the PG
   parameter names it was ultimately built to feed). Verify with
   `deno task check` (checks `src/index.ts`).
5. **`packages/fsm-core-async-op-worker/` is usually _not_ in this chain.** Its
   `fsmType`/`fsmLanguage`-carrying types (`RegisteredActor` in both
   `sidecar/protocol.ts` and `sidecar/gateway.ts`, `InvokeBody`,
   `ActivityInvokeInput`, `ClaimedAsyncOperationEvent`, …) are deliberately
   `string`, mirroring wire formats — a hand-rolled JSON socket protocol and a
   `.proto` file (checked directly: `fsm_type`/`fsm_language` are plain `string`
   in `sidecar_gateway.proto`, no enum) — that cross a Python/Rust/Go language
   boundary before this package ever sees the value. Don't reflexively tie them
   to `InvokeObject`/DB-generated types; that constraint wouldn't actually be
   enforced by the wire protocol or the non-TS workers. Only `fsm-core-db-ts`'s
   `AsyncOperationWorkerIdentity` (itself hand-written `string`, for the same
   reason — it flows through an opaque `jsonb` PG argument with no per-field
   generated type) is worth re-checking, and only if the DB change touches
   `claim_pending_async_operation_events_for_workers_v2` or
   `ensure_async_operation_queue_for_worker_v2` specifically.
6. **Re-publish `fsm-sync-worker-ts` and/or `fsm-core-async-op-worker` if either
   already shipped the changed code.** Both vendor `fsm-core-db-ts` source
   directly into their npm builds via `dnt` (resolved as a Deno workspace
   member, not an `npm:`/`jsr:` dependency — see each package's `CLAUDE.md`), so
   a fix published to `@pgfsm/db` on npm does **not** reach existing
   `@pgfsm/sync-worker`/`@pgfsm/async-worker` installs via semver. If this DB
   change touches code either package already bundled, cut a new release of that
   package too, or the fix silently won't reach its users.

## General principle

A hand-written TypeScript type should be expressed _in terms of_ the nearest
generated type (`Extract`/`Exclude`/`Omit`/`Partial`/indexed access) rather than
restated as a literal union or duplicated field-for-field, so a schema rename
either propagates automatically or fails loudly at `deno check` instead of
silently drifting. This only holds where the generated type is genuinely the
source of truth for that value _at that layer_ — see
`packages/fsm-compiler-ts/src/types/README.md` for a worked audit of which
hand-written types qualify ("already tied to the schema") and which don't
("intentionally distinct" — usually because a different source of truth, like a
wire protocol, applies instead). Section B.5 above is the same judgment call one
layer further out.
