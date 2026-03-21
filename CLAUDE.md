# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Finite State Machine (FSM) framework that runs workflows inside PostgreSQL, exposed via a Hono/Deno REST API. FSMs are defined as JSON schemas, compiled into database objects, and executed through the API with multiple execution models (direct, worker-based, promise-based).

## Language & Runtime Management

This repo uses [proto](https://moonrepo.dev/docs/proto/overview) to pin language versions. Check `.prototools` files for pinned versions. Key runtimes:
- **Deno 2.6.10** — primary runtime for API server and compiler
- **Node 22.16.0** — used only for `packages/database-src` (Supabase CLI)
- **Rust** — for the PostgreSQL extension in `packages/database-src-extension/`

## Commands

### API Server (`apps/fsm-core-ts-hono-deno/`)
```bash
deno run --allow-all --env-file=.env --watch main.ts   # dev server (port 9999)
deno test                                                # run tests
```

### FSM Compiler (`packages/fsm-compiler/`)
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
  fsm-core-db-ts/          # Raw pg client helpers (TypeScript)
  fsm-core-db-py/          # Raw pg client helpers (Python)
  fsm-core-db-drizzle/     # [IGNORE] Drizzle ORM experiment for fsm-core-db-ts — not used for active work
  fsm-core-example/        # Example FSM definitions (credit check, car vitals, etc.)
packages/
  database-src/            # PostgreSQL migrations + Supabase config
  database-src-extension/  # Rust PostgreSQL extension (pgrx) using ltree + pgmq
  fsm-compiler/            # JSON → database object compiler
```

### API Server Structure (`apps/fsm-core-ts-hono-deno/`)
- `app.ts` — Hono router composition, DB pool wiring
- `deno.ts` / `node.ts` — entry points for Deno and Node runtimes
- `env.ts` — Zod-validated environment config (`DB_TYPE`, `PORT`, `LOG_LEVEL`, etc.)
- `lib/create-app.ts` — app factory with middleware (Pino logging, request IDs, CORS)
- `lib/configure-open-api.ts` — OpenAPI/Scalar docs setup (available at `/docs`)
- `routes/fsm/` — core FSM operations: list, create, send
- `routes/fsmworker/` — background worker/queue processing
- `routes/fsmpromise/` — promise/callback-based workflows
- `stoker-src/` — OpenAPI helper utilities

### Database Layer
> Note: `fsm-core-db-drizzle` is a Drizzle ORM experiment for `fsm-core-db-ts` — ignore it for all work.
- `fsm-instance.ts` — create instances, manage state, archive events
- `fsm-helper.ts` — load states/transitions from JSON, DB queries
- `fsm-instance-lock.ts` — advisory lock concurrency control
- `queue.ts` — pgmq-based event queue management

### FSM Definition Format
FSMs are versioned JSON files in `apps/fsm-core-example/fsm/`. Each FSM folder (e.g., `v01/`, `v02/`) contains:
- `fsm.json` — state machine definition
- `xstate-fsm.json` — XState 5-compatible format
- TypeScript subdirectories for actors, actions, guards, delays

### Key Dependencies
- **Hono** with `@hono/zod-openapi` — REST framework + type-safe routes
- **Drizzle ORM 0.45.1** — database access (only in `fsm-core-db-drizzle`, which is ignored)
- **XState 5** — FSM definition format
- **Zod** — runtime validation
- **pgmq** — PostgreSQL message queue (for worker execution model)
- **ltree** — PostgreSQL tree structure (for state hierarchy)
- **Pino** — structured logging

### Environment Variables (`DB_TYPE` is key)
- `"postgres"` — direct PostgreSQL connection
- `"supabase"` — Supabase JS client
- `"supabase_and_postgres"` — both clients available
