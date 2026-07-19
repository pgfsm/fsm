# Contributing to FSM Framework

Thank you for your interest in contributing! This document explains how to get
involved.

## Contributor License Agreement (CLA)

Before your first Pull Request can be merged, you must sign the
[Contributor License Agreement](CLA.md).

**How it works:** When you open a PR, the cla-assistant bot will automatically
post a comment asking you to sign. Click the link, authenticate with GitHub, and
you're done. It takes about 30 seconds and only needs to happen once.

The CLA grants us the rights needed to maintain, relicense, and commercialize
the project while keeping it open source. Without it, we cannot accept your
contribution.

---

## Getting Started

### Prerequisites

This repo uses [proto](https://moonrepo.dev/docs/proto/overview) to manage
language versions. Install it first, then let it pin the correct versions
automatically.

Key runtimes:

- **Deno 2.8.1** — API server and compiler
- **Node 22.16.0** — `packages/database-src` only
- **Rust 1.95.0** — `packages/database-src-extension` only

### Pre-commit hooks

We use [prek](https://github.com/j178/prek) (`prek.toml`) to run fast local
checks on commit: **gitleaks** (secret scan), **deno fmt**, and **cargo fmt**.
Install once with `prek install`.

The hooks assume the pinned toolchain is on your `PATH` (which `proto` handles
in your shell). **If your GUI git client reports `deno`/`cargo` not found on
commit**, it isn't inheriting your shell `PATH` — a known limitation of version
managers with desktop apps. Fix it by committing from a **terminal**, or launch
your editor from an activated shell (e.g. `code .`). Windows users installing
via proto/rustup get the shims on the user `PATH` automatically.

### Running the project

```bash
# API server (port 9999)
cd apps/fsm-core-ts-hono-deno
deno run --allow-all --env-file=.env --watch main.ts

# Local database
cd packages/database-src
npm run supabase:start

# Load the example FSMs (creditCheck, carVitals, taskMachineConfig) into the
# local DB — required before running apps/fsm-core-example's DB-backed tests
deno task load

# Tests
deno test
```

The example FSM tests under `apps/fsm-core-example/fsm/*/v*/*-test.ts` compare
live DB behavior (`macrostepV2`, `resolveStateValue`, worker journeys) against
the FSM's own XState machine, so they need that FSM's `fsm.json` already loaded
into `fsm_core.fsm_states`/`fsm_transitions` — otherwise they fail with
`undefined` results rather than a useful error. `deno task load` (defined in
`apps/fsm-core-example/deno.json`) re-runs the compiler's `load` command against
every FSM in `apps/fsm-core-example/fsm/`; it's idempotent, so re-run it any
time you reset the local DB (`supabase:db:reset`) or change an example FSM's
`fsm.json`.

See [CLAUDE.md](CLAUDE.md) for the full command reference.

---

## How to Contribute

### Reporting Bugs

Open an issue with:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment info (OS, Deno version, DB version)

### Suggesting Features

Open an issue describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

We discuss features in issues before implementation work begins.

### Submitting Pull Requests

1. Fork the repository and create a branch from `main`
2. Make your changes
3. Ensure tests pass: `deno test`
4. Open a PR — the CLA bot will prompt you to sign if you haven't already
5. Address any review feedback

**PR guidelines:**

- Keep changes focused — one logical change per PR
- Write clear commit messages explaining _why_, not just _what_
- Do not add features, refactors, or abstractions beyond what the PR requires
- No new comments unless the reason is genuinely non-obvious

---

## Code Style

- **TypeScript**: Follow existing patterns in the codebase
- **Naming**: Follow the PG→TS naming conventions in [CLAUDE.md](CLAUDE.md)
- **No comments** unless the WHY is non-obvious (a hidden constraint, workaround
  for a specific bug, subtle invariant)
- Run `deno fmt` before committing

---

## Required Checks

Every PR runs two automated gates that must pass before it can be merged:

- **CLA Assistant** — verifies you've signed the [CLA](CLA.md). If not, the bot
  comments with a signing link; sign once and future PRs are cleared
  automatically.
- **REUSE Compliance** — verifies every file has declared copyright + license
  info. New files are covered automatically by the catch-all in `REUSE.toml`. If
  you add third-party code under a different license, add its text to
  `LICENSES/` and a matching `[[annotations]]` block in `REUSE.toml`.

## For Maintainers

These two checks are only enforced if `main` has a branch protection rule
requiring them. To enable it (**Settings → Branches → Add branch ruleset** for
`main`):

1. **Require a pull request before merging** — no direct pushes to `main`.
2. **Require status checks to pass**, and mark these as required:
   - `CLA Assistant`
   - `REUSE Compliance`
3. **Require branches to be up to date before merging** (recommended).

Without this rule the checks are advisory only — a red ✗ would not actually
block a merge.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE) and the terms of the [CLA](CLA.md).
