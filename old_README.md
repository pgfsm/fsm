<p align="center">
  <img src="./.github/assets/pgfsm-banner.svg" alt="pgfsm — finite state machines that run inside PostgreSQL" width="100%">
</p>

<h1 align="center">FSM Framework</h1>

<p align="center">
  <a href="https://discord.gg/FPNfaAbpq9"><img src="https://img.shields.io/badge/Discord-join%20chat-5865F2.svg?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="https://api.reuse.software/info/github.com/pgfsm/fsm"><img src="https://api.reuse.software/badge/github.com/pgfsm/fsm" alt="REUSE status"></a>
</p>

A framework for running versioned finite state machines inside PostgreSQL.

## What it is

FSMs are defined as JSON, compiled into database objects, and executed entirely
inside PostgreSQL. PostgreSQL owns the state at every step. Two planes
cooperate: a **control plane** decides where each instance runs, and a
per-instance **event flow** drives its transitions.

### Event flow — how a transition happens

<p align="center">
  <img src="./.github/assets/execution-model.svg" alt="Execution model: an event flows Client → REST API → PostgreSQL (pgmq.send) → instance queue; a worker dequeues it, runs a macrostep (resolve state, microstep_v2, run actions), archives the result, and loops back to readMessage()." width="90%">
</p>

```
Client
  │  POST /fsm/send  { fsm_instance_id, event_data }
  ▼
REST API (Hono/Deno)          ← writes an event log row, then pgmq.send()
  │
  ▼
PostgreSQL (fsm_core schema)  ← FSM definitions, instance state, per-instance event queue (pgmq)
  ▲
  │
Worker (fsmlet)               ← reads one message, runs a macrostep, writes new state back
```

Each FSM instance owns a dedicated pgmq queue. Events are messages in that
queue. A worker processes one message at a time, runs all triggered transitions
(a macrostep), and writes the new state back — atomically, inside a single PG
function call. See [Execution model](./docs/execution-model.md) for the full
trace.

### Control plane — how a worker gets placed (ADR-002, Stage 3)

Workers are not spawned per instance and do not race on a global queue. A
Kubernetes-style scheduler assigns each instance to a pre-registered worker node
(`fsmlet`) that has the right FSM module loaded and free capacity:

<p align="center">
  <img src="./.github/assets/control-plane.svg" alt="Control plane (ADR-002, Stage 3): API/fsmctl enqueues a dispatch entry into fsm_dispatch_queue and notifies fsm_scheduler_work; the fsmscheduler runs schedule_next_pending to pick a fsmlet with the module, a free slot, and a fresh heartbeat, then notifies fsm_fsmlet_work_<id>; the fsmlet claims the entry, runs startFSMWorkerWithDBLock, and heartbeats every 5s." width="80%">
</p>

```
API / fsmctl
  │  enqueue_fsm_dispatch_v2()  → INSERT fsm_dispatch_queue (status='pending')
  │                             → pg_notify('fsm_scheduler_work', instance_id)
  ▼
fsmscheduler                    ← LISTEN 'fsm_scheduler_work'
  │  schedule_next_pending():   pick a fsmlet from fsm_daemon_node that
  │    has the module, a free slot, and a fresh heartbeat (< 30s)
  │  → UPDATE status='scheduled' + pg_notify('fsm_fsmlet_work_<id>')
  ▼
fsmlet (one process per node)   ← LISTEN 'fsm_fsmlet_work_<id>'
     claims the entry → startFSMWorkerWithDBLock() → heartbeat every 5s
```

This gives real backpressure (a full node is never selected), correct routing
(module-aware placement), and liveness (dead nodes stop receiving work). See
[Worker execution model](./docs/adr/adr-002-worker-execution-model.md) for the
full rationale.

> **Future direction:** [KB-001](./docs/kb/kb-001-distributed-multilang-fsm.md)
> proposes splitting orchestration from activity workers across the queue so
> actors can be written in any language (TS, Python, Rust, Go). This is
> forward-looking guidance — today actors run in-process as TypeScript.

## Quick start

```bash
# 1. Start Supabase (PostgreSQL + pgmq + ltree)
cd packages/database-src && npm run supabase:start

# 2. Start the API server (port 9999)
cd apps/fsm-core-ts-hono-deno && deno run --allow-all --env-file=.env --watch main.ts
```

OpenAPI docs available at `http://localhost:9999/fsm/docs`.

## Example: creditCheck

The `creditCheck` FSM (in `apps/fsm-core-example/fsm/creditCheck/v01/`) models a
credit verification flow.

### States

```
┌─────────────────────────┐
│   Entering Information  │  ← initial
└──────────┬──────────────┘
           │ Submit
           ▼
┌─────────────────────────┐
│  Verifying Credentials  │  (invokes async actor)
└────┬──────────────┬─────┘
     │ done         │ error
     ▼              ▼
┌──────────────┐  ┌─────────────────────────┐
│ Checking     │  │   Entering Information  │  (retry)
│ Credit Scores│  └─────────────────────────┘
│ (parallel)   │
└──────────────┘
```

### Running it

```bash
BASE=http://localhost:9999/fsm

# 1. Create an instance
curl -s -X POST $BASE/fsm \
  -H "Content-Type: application/json" \
  -d '{"fsm_name": "creditCheck", "fsm_version": "v01", "fsm_context": {}}'
# → { "id": "550e8400-...", "fsm_instance_status": "active", ... }

INSTANCE_ID="550e8400-..."   # replace with the id from above

# 2. Start a worker for this instance
#    (direct/dev path — in production the scheduler → fsmlet control plane
#     places workers automatically; see "Control plane" above)
curl -s -X POST $BASE/fsmworker \
  -H "Content-Type: application/json" \
  -d "{\"queue\": \"$INSTANCE_ID\"}"

# 3. Send the Submit event
curl -s -X POST $BASE/fsm/send \
  -H "Content-Type: application/json" \
  -d "{\"fsm_instance_id\": \"$INSTANCE_ID\", \"event_data\": {\"type\": \"Submit\"}}"

# 4. Check state
curl -s $BASE/fsm | jq '.data[] | select(.id == "'$INSTANCE_ID'")'
```

## Project structure

```
apps/
  fsm-core-ts-hono-deno/   REST API — see apps/fsm-core-ts-hono-deno/README.md
  fsm-core-worker-ts/      Queue workers — see apps/fsm-core-worker-ts/README.md
  fsm-core-example/        Example FSM definitions — see apps/fsm-core-example/README.md
packages/
  database-src/            PostgreSQL schema + migrations — see packages/database-src/README.md
  database-src-extension/  Rust PG extension (ltree + pgmq) — see packages/database-src-extension/README.md
  fsm-compiler-ts/         FSM JSON compiler — see packages/fsm-compiler-ts/README.md
  fsm-core-db-ts/          Database access layer — see packages/fsm-core-db-ts/README.md
```

## Deeper reading

- [FSM definition format](./packages/fsm-compiler-ts/docs/reference/fsm-definition-format.md)
  — how to write `fsm.json`
- [Execution model](./docs/execution-model.md) — how an event flows from API to
  archive
- [PG→TS function mapping](./packages/database-src/docs/reference/pg-ts-function-mapping.md)
  — PostgreSQL ↔ TypeScript reference
- [Worker execution model](./docs/adr/adr-002-worker-execution-model.md) — how
  workers are scheduled and run (ADR-002, Stage 3)
- [Distributed, multi-language FSM](./docs/kb/kb-001-distributed-multilang-fsm.md)
  — the polyglot direction (KB-001)

## Community

- [Discord](https://discord.gg/FPNfaAbpq9) — chat, questions, and help
- [Contributing guide](./CONTRIBUTING.md) — how to get involved
- [Security policy](./SECURITY.md) — how to report a vulnerability
- [License](./LICENSE) — Apache-2.0
