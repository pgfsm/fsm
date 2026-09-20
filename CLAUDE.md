# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What This Is

distributed FSM platform where:

1. A single `fsm.json` can have **actors/actions/guards implemented in different
   languages** (TS, Python, Rust, Go…).
2. **Many instances of the same FSM** run concurrently; each instance has its
   own durable queue and is driven forward independently.
3. A worker **starts when an instance is created**, **out-of-band from the API**
   (the HTTP tier never blocks on or owns worker lifecycle).
4. **Database connections (pg Pool objects) are minimized**, even as instance
   count and the number of polyglot actor processes grow.

## Session Workflow

The session protocol — the session-type gate (explore / design-arch /
feature-bug-chore), the spec-driven design path, the issue-driven work path, and
the multi-agent coordination rules — is defined in `AGENTS.md` and applies to
every coding agent, Claude Code included. Follow it exactly; the full text is
imported below. For design/architecture sessions, use the `/design-spec` skill.

@AGENTS.md

## Language & Runtime Management

This repo uses [proto](https://moonrepo.dev/docs/proto/overview) to pin language
versions — root `.prototools` (Deno), `packages/database-src/.prototools`
(Node), root `rust-toolchain.toml` (Rust, via rustup). Those files are the
source of truth; CI installs from them. Never hardcode toolchain versions here
or in workflows.

## Architecture

```
apps/
  fsm-core-ts-hono-deno/   # Main REST API (Hono + Deno) — see CLAUDE.md
  fsm-core-example/        # Example FSM definitions, polyglot actors (TS/Python/Rust/Go) — see CLAUDE.md
packages/
  database-src/           # PostgreSQL migrations + Supabase config — see CLAUDE.md
  database-src-extension/ # Rust PostgreSQL extension (pgrx) using ltree + pgmq
  fsm-compiler-ts/        # JSON → database object compiler (TypeScript) — see CLAUDE.md
  fsm-core-db-ts/         # Raw pg client helpers (TypeScript) — see CLAUDE.md
  fsm-sync-worker-ts/     # Worker fleet: fsmlet/fsmscheduler dispatch-queue CLIs — see CLAUDE.md
  fsm-core-async-op-worker/ # Activity Gateway: async-op worker-registration/dispatch CLIs (@pgfsm/async-worker) — see CLAUDE.md
  fsm-async-worker-ts/    # Deprecated v1 async-op worker fleet (@pgfsm/async-worker-old); superseded by fsm-core-async-op-worker — see CLAUDE.md
  fsm-devstack-ts/        # fsmdev CLI: local dev-stack orchestration across compiler/sync-worker/async-worker, @pgfsm/devstack — see CLAUDE.md
  fsm-logging-ts/         # Shared LogTape logging config, @pgfsm/logging — see CLAUDE.md
  fsm-proto-codegen/      # Buf-driven multi-language proto stub generation — see CLAUDE.md
```

Each linked subdirectory has its own `CLAUDE.md` with commands, file structure,
dependencies, and naming conventions scoped to that area — consult it when
working there instead of duplicating detail here.

## Schema Change Propagation

`packages/database-src/` is the source of truth for both the FSM JSON schema and
the PostgreSQL schema; most other packages consume generated types derived from
one or the other. Editing either fans out through a specific chain of regenerate
→ review → verify steps across `fsm-compiler-ts`, `fsm-core-db-ts`,
`fsm-sync-worker-ts`, and (selectively — see the doc for why it's usually out of
scope there) `fsm-core-async-op-worker`. Follow
[`docs/schema-change-propagation.md`](docs/schema-change-propagation.md)
whenever a session touches `fsm.machine.schema.v3.json` or a SQL file under
`packages/database-src/supabase/schemas/`.
