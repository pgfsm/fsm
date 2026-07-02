# Contributing to FSM Framework

Thank you for your interest in contributing! This document explains how to get involved.

## Contributor License Agreement (CLA)

Before your first Pull Request can be merged, you must sign the [Contributor License Agreement](CLA.md).

**How it works:** When you open a PR, the cla-assistant bot will automatically post a comment asking you to sign. Click the link, authenticate with GitHub, and you're done. It takes about 30 seconds and only needs to happen once.

The CLA grants us the rights needed to maintain, relicense, and commercialize the project while keeping it open source. Without it, we cannot accept your contribution.

---

## Getting Started

### Prerequisites

This repo uses [proto](https://moonrepo.dev/docs/proto/overview) to manage language versions. Install it first, then let it pin the correct versions automatically.

Key runtimes:
- **Deno 2.6.10** — API server and compiler
- **Node 22.16.0** — `packages/database-src` only

### Running the project

```bash
# API server (port 9999)
cd apps/fsm-core-ts-hono-deno
deno run --allow-all --env-file=.env --watch main.ts

# Tests
deno test

# Local database
cd packages/database-src
npm run supabase:start
```

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
- Write clear commit messages explaining *why*, not just *what*
- Do not add features, refactors, or abstractions beyond what the PR requires
- No new comments unless the reason is genuinely non-obvious

---

## Code Style

- **TypeScript**: Follow existing patterns in the codebase
- **Naming**: Follow the PG→TS naming conventions in [CLAUDE.md](CLAUDE.md)
- **No comments** unless the WHY is non-obvious (a hidden constraint, workaround for a specific bug, subtle invariant)
- Run `deno fmt` before committing

---

## Required Checks

Every PR runs two automated gates that must pass before it can be merged:

- **CLA Assistant** — verifies you've signed the [CLA](CLA.md). If not, the bot comments with a signing link; sign once and future PRs are cleared automatically.
- **REUSE Compliance** — verifies every file has declared copyright + license info. New files are covered automatically by the catch-all in `REUSE.toml`. If you add third-party code under a different license, add its text to `LICENSES/` and a matching `[[annotations]]` block in `REUSE.toml`.

## For Maintainers

These two checks are only enforced if `main` has a branch protection rule requiring them. To enable it (**Settings → Branches → Add branch ruleset** for `main`):

1. **Require a pull request before merging** — no direct pushes to `main`.
2. **Require status checks to pass**, and mark these as required:
   - `CLA Assistant`
   - `REUSE Compliance`
3. **Require branches to be up to date before merging** (recommended).

Without this rule the checks are advisory only — a red ✗ would not actually block a merge.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE) and the terms of the [CLA](CLA.md).
