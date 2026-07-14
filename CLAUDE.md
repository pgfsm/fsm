# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What This Is

A Finite State Machine (FSM) framework that runs workflows inside PostgreSQL,
exposed via a Hono/Deno REST API. FSMs are defined as JSON schemas, compiled
into database objects, and executed through the API with multiple execution
models (direct, worker-based, promise-based).

## Session Workflow

The session protocol — the session-type gate (explore / design-arch /
spec-to-tickets / feature-bug-chore), the spec-driven design path, the
spec-to-tickets path, the issue-driven work path, and the multi-agent
coordination rules — is defined in `AGENTS.md` and applies to every coding
agent, Claude Code included. Follow it exactly; the full text is imported below.
For design/architecture sessions, use the `/design-spec` skill.

@AGENTS.md

## Language & Runtime Management

This repo uses [proto](https://moonrepo.dev/docs/proto/overview) to pin language
versions. Deno is pinned in the root `.prototools`, Node in
`packages/database-src/.prototools`, and Rust in the root `rust-toolchain.toml`
(proto delegates Rust to rustup, which reads that file). CI installs from the
same files — never hardcode toolchain versions in workflows. Key runtimes:

- **Deno 2.8.1** — primary runtime for API server and compiler
- **Node 22.16.0** — used only for `packages/database-src` (Supabase CLI)
- **Rust 1.95.0** — for the PostgreSQL extension in
  `packages/database-src-extension/`

## Commands

### API Server (`apps/fsm-core-ts-hono-deno/`)

```bash
deno run --allow-all --env-file=.env --watch main.ts   # dev server (port 9999)
deno test                                                # run tests
```

### FSM Compiler (`packages/fsm-compiler-ts/`)

```bash
deno run --allow-all --watch src/main.ts   # dev mode
```

### Database (`packages/database-src/`)

```bash
npm run supabase:start              # start local Supabase
npm run supabase:db:reset           # reset and re-run all migrations
npm run supabase:gen:types          # regenerate TypeScript types
npm run supabase:restart:with:diff  # restart and apply schema diff
```

### PostgreSQL Extension (`packages/database-src-extension/fsm_core/`)

Built with `pgrx` — see the package README for build instructions.

## Architecture

```
apps/
  fsm-core-ts-hono-deno/   # Main REST API (Hono + Deno)
  fsm-core-db-py/          # Raw pg client helpers (Python)
  fsm-core-db-drizzle/     # [IGNORE] Drizzle ORM experiment for fsm-core-db-ts — not used for active work
  fsm-core-example/        # Example FSM definitions (credit check, car vitals, etc.)
packages/
  database-src/            # PostgreSQL migrations + Supabase config
  database-src-extension/  # Rust PostgreSQL extension (pgrx) using ltree + pgmq
  fsm-compiler-ts/         # JSON → database object compiler (TypeScript)
  fsm-core-db-ts/          # Raw pg client helpers (TypeScript)
  fsm-compiler-py/         # JSON → database object compiler (Python)
```

### API Server Structure (`apps/fsm-core-ts-hono-deno/`)

- `app.ts` — Hono router composition, DB pool wiring
- `deno.ts` / `node.ts` — entry points for Deno and Node runtimes
- `env.ts` — Zod-validated environment config (`DB_TYPE`, `PORT`, `LOG_LEVEL`,
  etc.)
- `lib/create-app.ts` — app factory with middleware (Pino logging, request IDs,
  CORS)
- `lib/configure-open-api.ts` — OpenAPI/Scalar docs setup (available at `/docs`)
- `routes/fsm/` — core FSM operations: list, create, send
- `routes/fsmworker/` — background worker/queue processing
- `routes/fsmpromise/` — promise/callback-based workflows
- `stoker-src/` — OpenAPI helper utilities

### Database Layer

> Note: `fsm-core-db-drizzle` is a Drizzle ORM experiment for `fsm-core-db-ts` —
> ignore it for all work.

- `fsm-instance.ts` — create instances, manage state, archive events
- `fsm-helper.ts` — load states/transitions from JSON, DB queries
- `fsm-instance-lock.ts` — advisory lock concurrency control
- `queue.ts` — pgmq-based event queue management

### FSM Definition Format

FSMs are versioned JSON files in `apps/fsm-core-example/fsm/`. Each FSM folder
(e.g., `v01/`, `v02/`) contains:

- `fsm.json` — state machine definition
- `xstate-fsm.json` — XState 5-compatible format
- TypeScript subdirectories for actors, actions, guards, delays

### Key Dependencies

- **Hono** with `@hono/zod-openapi` — REST framework + type-safe routes
- **Drizzle ORM 0.45.1** — database access (only in `fsm-core-db-drizzle`, which
  is ignored)
- **XState 5** — FSM definition format
- **Zod** — runtime validation
- **pgmq** — PostgreSQL message queue (for worker execution model)
- **ltree** — PostgreSQL tree structure (for state hierarchy)
- **Pino** — structured logging

### Environment Variables (`DB_TYPE` is key)

- `"postgres"` — direct PostgreSQL connection
- `"supabase"` — Supabase JS client
- `"supabase_and_postgres"` — both clients available

## Naming Conventions

PostgreSQL is the source of truth. TypeScript wrappers in
`packages/fsm-core-db-ts/src/` must stay aligned with PG function names and
parameter names.

### PG → TS Function Name Rules

- Strip `_v1` / `_v2` version suffix from TS names — version is driven by
  `FSM_SCHEMA_FN_VERSION = "v2"` in `const.ts`
- Use camelCase matching the PG snake_case name (e.g.,
  `archive_event_from_fsm_type_worker_v2` → `archiveEventFromFsmTypeWorker`)
- No added verbs or abbreviations not in the PG name

### Parameter Name Rules (PG schema)

- All PG function parameters use `input_*` prefix (e.g., `input_fsm_name`,
  `input_state_value`)
- Exception: internal orchestration params keep their names (e.g.,
  `fsm_name_param`, `event_name`, `transition_record`)
- v1 functions still use `p_*` prefix — not to be changed (superseded by v2)

### Reference Document

See `packages/database-src/docs/reference/pg-ts-function-mapping.md` for the
complete PG→TS function mapping table, including:

- All 18 direct 1:1 mappings (Table 1)
- TS functions not directly mapped to a PG function (Table 2)
- Gap: PG functions with no TS wrapper (Table 3)
