# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What This Is

A Finite State Machine (FSM) framework that runs workflows inside PostgreSQL,
exposed via a Hono/Deno REST API. FSMs are defined as JSON schemas, compiled
into database objects, and executed through the API with multiple execution
models (direct, worker-based, promise-based).

## Session Workflow (GitHub Issues)

At the start of every session, before doing anything else, ask:

> "What are we doing in this session today? a) Explore / understand the
> codebase, experiment, or general Q&A b) Working on this codebase (feature,
> bug, or chore)"

### If (a) — explore / experiment / Q&A

Continue normally. Don't touch GitHub issues. Code changes are fine here —
experiments and throwaway work don't need an issue.

### If (b) — working on the codebase

1. Show the repo link and the issue lists from session-start context (issues
   assigned to the user, plus unassigned ones).
2. Ask: "Which issue number are you working on? Or, if it's not listed, say 'not
   in list' and I'll help you create one."

#### If they give an issue number

- Look it up to confirm it exists and read details: `gh issue view <n>`
- Assign it: `gh issue edit <n> --add-assignee @me`
- Link this session:
  `gh issue comment <n> --body "🤖 Claude session linked: $(cat .claude/.current-session-id)"`
- Confirm the type from its labels; if missing, ask and add one (**feature =
  `enhancement`**): `gh issue edit <n> --add-label <bug|enhancement|chore>`

#### If they say "not in list" (or the number doesn't exist)

Ask for:

- Type: bug, feature (label: `enhancement`), or chore
- A short title
- A one-paragraph description
- For bugs: repro steps and expected vs. actual behavior
- For features: the user-facing outcome and any acceptance criteria
- For chores: why it's needed and what "done" looks like

Then create, assign, and link:

```bash
gh issue create --title "<title>" --body "<body>" --label <type> --assignee @me
gh issue comment <new-n> --body "🤖 Claude session linked: $(cat .claude/.current-session-id)"
```

Issues created via `gh` bypass the issue forms, so also add the matching
`area: *` label — the component→label mapping lives in
`.github/advanced-issue-labeler.yml`.

### Conventions

- Branch: `<type>/<issue-number>-short-slug` (e.g.
  `bug/142-worker-lock-timeout`)
- Commits reference the issue: `fix(worker): handle lock timeout (#142)`
- PRs include `Closes #<number>` so merging auto-closes the issue.

### Branch vs worktree

- Default to working directly on a branch in the current directory.
- If the user mentions another Claude session is already active on this repo, or
  explicitly asks for isolation/parallel work, create a worktree instead:
  `git worktree add .claude/worktrees/<type>-<issue-number> -b <type>/<issue-number>-slug`
- Tell the user the worktree path so they can open a second terminal there if
  needed.
- Caveat for parallel worktrees in this repo: the API dev server (port 9999) and
  local Supabase are shared services. Only one worktree can run them at a time —
  coordinate with the user before starting either, or change `PORT` in that
  worktree's `.env`.

## Language & Runtime Management

This repo uses [proto](https://moonrepo.dev/docs/proto/overview) to pin language
versions. Check `.prototools` files for pinned versions. Key runtimes:

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
