# Architecture Decision Records

ADRs are kept close to the code they govern. This index links to all ADRs across
the monorepo.

## Cross-cutting (this folder)

| ADR                                          | Title                                                                                          | Status                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ |
| [ADR-001](adr-001-logging-library.md)        | Logging Library — LogTape for @pgfsm/worker, @pgfsm/db, @pgfsm/compiler                        | Accepted                 |
| [ADR-002](adr-002-worker-execution-model.md) | FSM Worker Execution Model Evolution (Stages 1–3) — covers process model and dispatch strategy | Current (Stage 3 active) |

## packages/database-src

| ADR                                                                                       | Title                                               | Status   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- | -------- |
| [ADR-001](../../packages/database-src/docs/adr/adr-001-rls-policy.md)                     | Do Not Use PostgreSQL Row Security Policies (RLS)   | Accepted |
| [ADR-002](../../packages/database-src/docs/adr/adr-002-nodejs-npm-pinned-supabase-cli.md) | Node.js + npm, with a Pinned `supabase` CLI Version | Accepted |

## packages/database-src-extension

| ADR                                                                                         | Title                                                 | Status   |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| [ADR-001](../../packages/database-src-extension/docs/adr/adr-001-extension-language-sql.md) | Use SQL/PL/pgSQL for PostgreSQL Extension Development | Accepted |
