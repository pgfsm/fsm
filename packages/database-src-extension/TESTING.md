# Testing the fsm_core PostgreSQL Extension

## Prerequisites

Before running any tests, ensure:

1. **pgrx initialized** — run once to download and configure a local PostgreSQL instance:
   ```sh
   cargo pgrx init --pg15 download
   ```

2. **pgmq installed** into the pgrx-managed PostgreSQL instance (required at runtime by `fsm_core`):
   ```sh
   uvx pgxnclient install pgmq --pg_config "$HOME/.pgrx/15.16/pgrx-install/bin/pg_config"
   ```
   To find the exact PostgreSQL version and pg_config path:
   ```sh
   cargo pgrx info version pg15    # e.g. 15.16
   cargo pgrx info pg-config pg15  # e.g. $HOME/.pgrx/15.16/pgrx-install/bin/pg_config
   ```

All commands below should be run from `packages/database-src-extension/fsm_core/`.

---

## Test Types

| Type | Command | What it covers |
|------|---------|----------------|
| pgrx unit tests | `cargo pgrx test pg15` | Rust `#[pg_test]` functions in `src/lib.rs` |
| pg_regress | `cargo pgrx regress pg15` | SQL output comparison against `tests/pg_regress/expected/` |
| Interactive / smoke | `cargo pgrx run` | Manual psql session with the extension loaded |

---

## pgrx Unit Tests

pgrx spins up a temporary PostgreSQL instance, loads the extension, runs all `#[pg_test]` functions, then tears it down.

```sh
cargo pgrx test pg15
```

Current tests (in `src/lib.rs`):
- `test_hello_fsm_core` — asserts `hello_fsm_core()` returns `"Hello, fsm_core"`

### Adding a new unit test

Add a `#[pg_test]` function inside the `tests` module in `src/lib.rs`:

```rust
#[pg_test]
fn test_my_function() {
    // runs inside a real PostgreSQL transaction
    assert_eq!(expected, crate::my_function());
}
```

---

## pg_regress Tests

pgrx runs the SQL scripts in `tests/pg_regress/sql/` and diffs output against `tests/pg_regress/expected/`.

```sh
cargo pgrx regress pg15
```

Current test: `setup.sql` — creates the extension and verifies it loads without error.

### Adding a new regression test

1. Add a `.sql` file to `tests/pg_regress/sql/`
2. Run the test once to capture actual output, then copy it to `tests/pg_regress/expected/` as the expected baseline.

---

## Interactive Smoke Test

`cargo pgrx run` launches a local PostgreSQL instance with `fsm_core` installed and drops you into a psql session.

```sh
cargo pgrx run
```

Inside psql:

```sql
-- Load the extension (CASCADE also installs ltree and pgmq)
CREATE EXTENSION fsm_core CASCADE;

-- Rust-defined function
SELECT hello_fsm_core();

-- SQL-defined function (from sql/fsm_core--1.0.sql)
SELECT fsm_core.hello('BOB');

-- Confirm all three extensions loaded
SELECT extname FROM pg_extension ORDER BY extname;
```

Expected output:
```
 hello_fsm_core
----------------
 Hello, fsm_core

NOTICE:  Hello, BOB!

  extname
----------
 fsm_core
 ltree
 pgmq
```

---

## Build and Package

To produce an installable extension package:

```sh
cargo pgrx package --pg-config "$HOME/.pgrx/15.16/pgrx-install/bin/pg_config"
```

Output is written to `target/release/fsm_core-pg15/`. The package directory will contain:
- `fsm_core.dylib` (macOS) or `fsm_core.so` (Linux) — the compiled extension
- `fsm_core.control` — extension metadata
- `fsm_core--0.0.0.sql` — generated SQL (includes content from `sql/fsm_core--1.0.sql`)

### How SQL files are bundled

`src/lib.rs` uses the `extension_sql_file!` macro to embed `sql/fsm_core--1.0.sql` into the extension:

```rust
extension_sql_file!("../sql/fsm_core--1.0.sql", name = "fsm_core_1_0_sql");
```

At build time, pgrx generates SQL for all Rust-defined items (`#[pg_extern]`) and merges in the contents of the SQL file. The result appears in the packaged `fsm_core--<version>.sql`. No separate SQL copy step is needed — editing `sql/fsm_core--1.0.sql` and rebuilding is sufficient.
