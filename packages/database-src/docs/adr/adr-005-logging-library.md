# ADR-005: Logging Library — LogTape for @pgfsm/worker, @pgfsm/db, @pgfsm/compiler

**Status:** Accepted  
**Date:** 2026-06-24

---

## Context

Three packages in the monorepo had no structured logging — only ad-hoc `console.log/warn/error` calls with emoji prefixes:

- `apps/fsm-core-worker-ts` (`@pgfsm/worker`) — 81 console calls across 7 files
- `packages/fsm-core-db-ts` (`@pgfsm/db`) — 22 console calls, all in catch blocks
- `packages/fsm-compiler-ts` (`@pgfsm/compiler`) — 60+ console calls across 6 files

Each package is used in two contexts:

1. **CLI** — `@pgfsm/worker` has `src/cli/daemon.ts` and `src/cli/index.ts`; `@pgfsm/compiler` has `src/cli/index.ts`. These run in a developer's terminal and benefit from colored, grouped, human-readable output.
2. **Embedded in the Hono app** — `apps/fsm-core-ts-hono-deno` imports all three packages in-process. This context benefits from flat, structured, machine-readable output compatible with log aggregators.

The key requirement was **group-collapsed style output** in the CLI: instead of scrolling flat lines for a single FSM message processing cycle, show a visual hierarchy that lets the developer scan at a glance (e.g., `@pgfsm/worker·macrostep·actions` nested under `@pgfsm/worker·worker`).

A secondary requirement was **zero-npm for library code** — the packages target Deno as the primary runtime.

---

## Decision

We adopt **LogTape** (`jsr:@logtape/logtape@^2.2`) as the logging library across all three packages.

Each package:

1. Adds `@logtape/logtape` to its `deno.json` imports (JSR, no npm dependency).
2. Creates `src/logger.ts` exporting a `configureXxxLogger(level?)` function.
3. Uses `getLogger(["@pgfsm/<package>", "<module>"])` in every library file — never calls `configure()` itself.
4. CLI entrypoints call `configureXxxLogger()` once at startup.
5. Embedding apps (e.g., the Hono server) can call the same function or their own `configure()` call to route logs into their pipeline.

### Category structure

The root of each category array is the package name, matching the JSR/npm package identity:

```
@pgfsm/worker   → ["@pgfsm/worker", "worker"]
                   ["@pgfsm/worker", "macrostep"]
                   ["@pgfsm/worker", "macrostep", "actions"]
                   ["@pgfsm/worker", "promise"]
                   ["@pgfsm/worker", "dispatcher"]
                   ["@pgfsm/worker", "bootstrap"]

@pgfsm/db       → ["@pgfsm/db"]
                   ["@pgfsm/db", "instance"]
                   ["@pgfsm/db", "helper"]
                   ["@pgfsm/db", "queue"]
                   ["@pgfsm/db", "lock"]

@pgfsm/compiler → ["@pgfsm/compiler", "generate"]
                   ["@pgfsm/compiler", "validate"]
                   ["@pgfsm/compiler", "load"]
                   ["@pgfsm/compiler", "plugin"]
                   ["@pgfsm/compiler", "delete"]
```

The `configure()` root in each `logger.ts` matches the package root (e.g., `["@pgfsm/worker"]`), so each package's sink only captures its own loggers — no cross-package bleed.

### Two output profiles in configureXxxLogger()

```
TTY detected (CLI terminal)
  → getSummaryConsoleSink()
  → Level: debug (show everything)
  → Deep debug logs (category.length > 2): repaint current line with \r (no scroll)
  → All other logs: clear line, print ✨ [@pgfsm/worker.macrostep] <message>

Non-TTY (piped, Hono in-process, CI)
  → getConsoleSink()          ← LogTape built-in, no custom code
  → Level: caller-supplied (default: "info")
  → Flat structured output, no ANSI codes
```

TTY detection uses `Deno.stdout.isTerminal()` when running in Deno, falling back to `process.stdout?.isTTY` for Node compat.

### Message rendering

LogTape stores structured log calls (`logger.info("text: {key}", { key: val })`) as an interleaved array `["text: ", val, ""]`. The custom sink renders this with:

```ts
record.message.map(p => typeof p === "string" ? p : JSON.stringify(p)).join("")
```

### What stays as console.*

CLI-specific UX output is intentionally kept as plain `console.*` — help text, argument validation errors, SIGINT shutdown messages. These are user-facing interactive messages, not library logging, and should never be suppressed by a log level.

---

## Consequences

### Positive

- **Visual hierarchy in terminal** — The category path (`@pgfsm/worker·macrostep·actions`) communicates nesting context on every log line without any custom sink logic. Deep debug logs repaint in place rather than scrolling, keeping the terminal usable during a noisy FSM cycle.
- **Zero npm dependency** — LogTape is on JSR (`jsr:@logtape/logtape`). All three packages already use JSR for stdlib; this adds no npm surface area.
- **Library-author pattern** — Library files call `getLogger()` only. `configure()` is never called from library code. The CLI entrypoint configures for the terminal; embedding apps configure for their pipeline. LogTape silently drops logs if `configure()` is never called, which is safe.
- **Package-scoped root categories** — Using the JSR package name (`@pgfsm/worker`) as the root category makes log routing in multi-package embedding apps unambiguous. Each package's logs can be independently filtered or sunk.
- **No conflict with Pino** — The Hono app already uses Pino 9.6.0 for HTTP request/response logging via `hono-pino`. LogTape handles FSM operational logging, which is a separate concern occurring outside the HTTP request lifecycle. The two loggers share stdout but do not interfere.

### Negative / Trade-offs

- **configure() is global and one-shot** — LogTape's `configure()` applies to the entire process. If the Hono app embeds all three packages, all three `configureXxxLogger()` functions cannot be called independently — the last one wins. Embedding apps that use multiple `@pgfsm/*` packages must call `configure()` once themselves with all desired logger entries, rather than delegating to each package's helper. The helpers remain useful for single-package CLI use.
- **No true collapsible groups** — "Group collapsed" in a terminal context means indented category labels and inline-repainted debug lines, not browser-DevTools-style collapsible sections. There is no terminal equivalent to `console.groupCollapsed`.
- **LogTape 2.x is relatively new** — The JSR package (2.2.1 at time of adoption) is stable but has a shorter production track record than Pino or Winston.

---

## Alternatives Considered

### Pino (already in Hono app)

Pino 9.6.0 is already installed in `apps/fsm-core-ts-hono-deno`. Using it in the worker/db/compiler packages would maintain library consistency.

Rejected because:
- Pino emits flat sequential JSON lines. `.child()` adds context fields to every line but does not produce visual nesting in the terminal.
- `pino-pretty` produces colored output but still renders sequentially — no line-repaint or hierarchy.
- The stated requirement was specifically visual group-collapsed output in the CLI.

### Consola

Consola has native `group()`/`groupEnd()` support with `FancyReporter` rendering indented blocks, and a swappable reporter model designed for library authors.

Not selected because:
- Consola is distributed via npm (`npm:consola`), adding an npm dependency to packages that otherwise use JSR/Deno-native imports.
- LogTape achieves equivalent visual grouping via category hierarchy with a built-in JSR package.
- LogTape's `getSummaryConsoleSink` custom sink (see above) replicates the inline-repaint behavior, which is a one-time ~30-line implementation.

### @std/log (Deno stdlib)

Native Deno, zero external dependency, familiar `Logger`/`Handler` pattern.

Rejected because:
- No concept of hierarchical categories.
- `ConsoleHandler` formats flat lines with a level prefix; no structured property support.
- Would require a full custom formatter and sink to match what LogTape provides built-in.

---

## Files

| Package | New files | Modified files |
|---|---|---|
| `@pgfsm/worker` | `src/logger.ts` | `deno.json`, `src/index.ts`, `src/fsmworker.ts`, `src/fsmworker-helper.ts`, `src/fsmpromiseworker.ts`, `src/create-and-start-promise-worker.ts`, `src/run-fsm-dispatch-daemon.ts`, `src/bootstrap-fsm-modules.ts`, `src/cli/daemon.ts`, `src/cli/index.ts` |
| `@pgfsm/db` | `src/logger.ts` | `deno.json`, `src/index.ts`, `src/pg-utils.ts`, `src/fsm-instance.ts`, `src/fsm-helper.ts`, `src/queue.ts`, `src/fsm-instance-lock.ts` |
| `@pgfsm/compiler` | `src/logger.ts` | `deno.json`, `src/index.ts`, `src/generate-fsm-json.ts`, `src/generate-fsm-plugin.ts`, `src/load-fsm-json.ts`, `src/validate-fsm-plugin-load.ts`, `src/validate-and-load-fsm.ts`, `src/delete-fsm-json-from-folders.ts`, `src/cli/index.ts` |
