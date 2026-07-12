# fsm-logging-ts — Shared Logging Foundation

The single owner of logging config for the repo. A leaf package (depends only on
`@logtape/*`) that wraps [LogTape](https://logtape.org) with one configurator, a
shared category vocabulary, and a console sink that renders attached data in the
most readable shape (table / dir / log).

## What it does

- `configureLogging(opts)` — the one process-wide LogTape configurator
- `CATEGORY` — canonical namespaces (`api`, `worker`, `db`, `compiler`,
  `fsmlet`) so every package speaks the same category vocabulary
- `LogLevel` — LogTape's severities plus `"silent"` (routed to a noop sink)
- A console sink (`getTableConsoleSink`) that formats the message line with
  LogTape's built-in ANSI/text formatters, and renders values attached via
  `table()` / `dir()` / `inspect()` as `console.table` / `console.dir`
- Optional OpenTelemetry sink alongside the console (`otel: true`)

## The golden rule

**`configureLogging()` is called exactly once per process, at the entry point.**
Calling LogTape's `configure()` twice in one process throws.

- **Apps/CLIs configure** — each composition root (API `deno.ts`, each worker/
  compiler CLI, test files) resolves levels from its own validated env and calls
  `configureLogging()` once.
- **Libraries never configure** — they only `getLogger([CATEGORY.x, ...])` from
  `@logtape/logtape`. A library that is also a CLI (e.g. the compiler)
  configures only when it is the process root, never on import.
- **Env is read at the composition root**, not here — this package is
  env-agnostic and takes explicit levels (dependency injection).

## Configuring at an entry point

```typescript
import {
  CATEGORY,
  configureLogging,
  isTerminal,
  type LogLevel,
} from "@pgfsm/logging";

// Resolve levels from your OWN validated env, then configure once.
await configureLogging({
  levels: {
    [CATEGORY.api]: "info",
    [CATEGORY.worker]: "debug",
    [CATEGORY.db]: "warning",
    [CATEGORY.compiler]: "silent", // routed to a noop sink — nothing emitted
  },
  otel: true, // optional; OTLP endpoint read by the OTel SDK from env
});
```

Only the categories you list are configured. To add a category's logs to a
process, add `[CATEGORY.x]: level` to that entry point's call — do **not** add a
second `configure()`. `isTerminal` is exported so a root can, e.g., force
`"debug"` on a TTY.

## Logging in a library

Libraries import nothing from this package except `CATEGORY` — they use
LogTape's `getLogger` directly:

```typescript
import { getLogger } from "@logtape/logtape";
import { CATEGORY } from "@pgfsm/logging";

const logger = getLogger([CATEGORY.compiler, "validate"]);

logger.info("Validated {count} folders", { count: 12 });
```

## Rendering data: table / dir / inspect

Attach a value with an opt-in helper as the second argument to a log call. Each
returns a LogTape _properties_ object, so it merges with normal structured
fields. The sink renders the attached value beneath the message line **on a
TTY**; piped/non-TTY output emits it as a single greppable JSON line instead.

```typescript
import { dir, inspect, table } from "@pgfsm/logging";

// force a table — flat object prints as key/value rows
logger.info(
  "Database config",
  table({ host: "localhost", port: 5432, ssl: true }),
);

// narrow the columns (2nd arg): array columns, or a flat-object key allow-list
logger.info("Results", table(rows, ["id", "name"]));

// force console.dir with full depth — best for nested objects
logger.info(
  "Incoming request",
  dir({ method: "POST", body: { name: "Alice" } }),
);

// let the sink decide from the value's shape (see table below)
logger.info("Users", inspect(users));
```

Use `table()` when you want a specific mode or to narrow columns; otherwise you
can rely on the auto behavior below.

### Auto-render from a bare property (no helper)

You don't have to wrap data in a helper at all. Any **extra** property — one
whose value is a non-primitive (array/object) and that is **not** interpolated
into the message template — is auto-rendered beneath the line with its key as a
label, using the same shape decision as `inspect()`:

```typescript
logger.info("All folder validation results ({count}):", {
  count: allFolderResults.length,
  allFolderResults,
});
```

```text
All folder validation results (5):
allFolderResults
┌───────┬──────────┬────────────┐
│ (idx) │ fsmName  │ fsmVersion │
│  ...  │   ...    │    ...     │
└───────┴──────────┴────────────┘
```

Rules that keep this from becoming noisy:

- **Interpolated properties are skipped.** `count` is referenced as `{count}` in
  the template, so it renders inline (`(5)`) and is not tabled. This means the
  common `logger.error("failed: {error}", { error: err })` pattern shows the
  error in the message line only — never double-rendered.
- **Scalars are skipped.** Only arrays/objects auto-render; a bare
  `requestId:
  "abc"` stays in the structured record (for OTel/files). Put
  scalars you want on-screen in the message template via `{placeholder}`.
- **TTY only.** Auto-render is for interactive terminals; piped output leaves
  extra properties in the record for structured sinks and doesn't echo them.

Reach for the explicit `table()` / `dir()` / `inspect()` helpers when you need
to force a mode, narrow columns, or render a value that _is_ also interpolated.

### Decision table (`inspect` / auto mode)

| Value                               | Rendered with                    |
| ----------------------------------- | -------------------------------- |
| Array (of objects or of primitives) | `console.table`                  |
| Flat object (all primitive values)  | `console.table` (key/value rows) |
| Nested object                       | `console.dir({ depth: null })`   |
| string / number / boolean           | `console.log`                    |

`table()` and `dir()` force their mode; `inspect()` applies the table above. On
a non-TTY, the attached value is emitted as one JSON line regardless of mode.

## Why a custom sink

LogTape's built-in `getConsoleSink` dispatches only to
`console.log/info/warn/error` (chosen by log level) — it can never call
`console.table` or `console.dir`. So the shape-based routing needs a custom
sink. Everything else reuses the library: the message line comes from LogTape's
built-in `getAnsiColorFormatter` (TTY) / `getTextFormatter` (non-TTY).

## Key files

| File                | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `src/configure.ts`  | `configureLogging()` — the one process-wide configurator |
| `src/sink.ts`       | Console sink: built-in formatter + table/dir/log routing |
| `src/render.ts`     | `table()` / `dir()` / `inspect()` payload builders       |
| `src/categories.ts` | `CATEGORY` namespace constants                           |
| `src/types.ts`      | `LogLevel` (LogTape severities + `"silent"`)             |
| `src/index.ts`      | Public barrel exports                                    |
