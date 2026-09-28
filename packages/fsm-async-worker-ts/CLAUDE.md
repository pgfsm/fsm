# CLAUDE.md — Async-Operation Worker Fleet (`packages/fsm-async-worker-ts/`)

Scoped guidance for `@pgfsm/async-worker-old`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

The out-of-band worker fleet that drives promise/callback-based async operations
forward — the equivalent of the fsmlet (`packages/fsm-sync-worker-ts/`) /
fsmscheduler / fsmctl (`packages/fsm-ctl-ts/`) trio, but for `async_operation_*`
dispatch tables instead of `fsm_dispatch_queue`. Kubernetes-style split:
`async-operation-workerlet` (kubelet — long-running node agent) is routed work
by `async-operation-scheduler` (kube-scheduler — control plane, run once per
cluster), driven one-shot by `async-operation-ctl`.

Full CLI reference (flags, defaults, examples) lives in
`docs/guides/CLI-USAGE.md` — read it before invoking any of these directly.

## Commands

```bash
deno task async-operation-workerlet # node agent — claims & drives async-operation workers
deno task async-operation-scheduler # control-plane router (run once per cluster)
deno task async-operation-ctl       # one-shot control CLI
deno task check                     # deno check src/index.ts
```

## Structure (`src/`)

- `cli/` — three CLI entry points (`async-operation-workerlet.ts`,
  `async-operation-scheduler.ts`, `async-operation-ctl.ts`)
- `asyncOperationWorkerlet/` — node-agent implementation, including
  `fsmasyncoperationworker.py` (a polyglot example actor, not leftover Python
  tooling)
- `asyncOperationScheduler/` — control-plane routing implementation
- `logger.ts` — composition-root LogTape config for this process
