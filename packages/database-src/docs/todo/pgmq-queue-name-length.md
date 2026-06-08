# pgmq Queue Name Length — TODOs

See limitation: [pgmq-queue-name-length.md](../limitation/pgmq-queue-name-length.md)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Add queue name length validation in `create_promise_queue_and_send_event_from_fsm_instance_id_v2` | 🔲 Pending | Raise a clear error before calling `pgmq.create()` when the derived queue name exceeds 47 chars |
| 2 | Add queue name length validation in the FSM compiler | 🔲 Pending | Catch naming violations at compile time rather than runtime |
| 3 | Document naming convention rule in developer docs | 🔲 Pending | `parentFsmName + _ + parentFsmVersion + _ + fsmName` must not exceed 47 chars; add to `docs/development.md` |
| 4 | Add a helper or lint check that computes promise queue name length from FSM definition | 🔲 Pending | Could be part of the compiler or a standalone validation step |
