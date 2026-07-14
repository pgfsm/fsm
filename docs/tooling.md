# Tooling

A catalogue of every tool used in this repository — for local development and in
CI/CD — grouped by purpose. This is a polyglot repo (Deno/TypeScript, Node,
Rust) with PostgreSQL as the source of truth, so the toolchain spans three
ecosystems.

- **Local development** — anything you run on your own machine while working.
- **CI/CD pipeline** — GitHub Actions workflows in `.github/workflows/`.

---

## 1. Language & version management

`proto` pins every language runtime to an exact version, ensuring all
contributors and CI use identical toolchains across the three ecosystems.

| Tool                                                  | Purpose                                        | Pinned in                                                   |
| ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| [**proto**](https://moonrepo.dev/docs/proto/overview) | Pins language/runtime versions                 | Root `.prototools` (packages inherit; may override)         |
| **Deno** `2.8.1`                                      | Primary runtime — API server, compiler, worker | Root `.prototools`                                          |
| **Node** `22.16.0`                                    | Runs Supabase CLI tooling only                 | `packages/database-src/.prototools`                         |
| **Rust** `1.95.0`                                     | PostgreSQL extension                           | Root `rust-toolchain.toml` (proto delegates Rust to rustup) |

> Run `proto use` to install the pinned versions. CI (`prek.yml`, `ci.yml`)
> installs from the same files via `moonrepo/setup-toolchain` and a bare
> `rustup toolchain install` — don't hardcode toolchain versions in workflows.

---

## 2. Dependency management (per ecosystem)

Each ecosystem uses its own native package manager; this table records which
tool, manifest, and lockfile apply to each part of the repo.

| Ecosystem    | Tool                            | Manifest / lockfile                      | Location                                   |
| ------------ | ------------------------------- | ---------------------------------------- | ------------------------------------------ |
| Deno / TS    | **Deno** (JSR + npm specifiers) | `deno.json` + `deno.lock`                | repo root (workspace of 5 members)         |
| Node         | **npm**                         | `package.json` + `package-lock.json`     | `packages/database-src`                    |
| Rust         | **Cargo**                       | `Cargo.toml` + `Cargo.lock`              | `packages/database-src-extension/fsm_core` |
| PG extension | **pgrx** `=0.18.1`              | pinned in `Cargo.toml`, tied to PG major | `packages/database-src-extension/fsm_core` |

---

## 3. Dependency auto-update

Renovate Bot opens automated PRs to keep dependencies current across all three
ecosystems and GitHub Actions, reducing manual version-bump toil.

| Tool                                              | Purpose                                                                  | Config          |
| ------------------------------------------------- | ------------------------------------------------------------------------ | --------------- |
| [**Renovate Bot**](https://docs.renovatebot.com/) | Automated dependency-update PRs across Deno, npm, Cargo & GitHub Actions | `renovate.json` |

Notable Renovate policy (`renovate.json`):

- Scheduled **before 9am Monday UTC**, concurrency-limited (10 PRs / 2 per
  hour).
- Grouped updates: Deno std, LogTape, Hono, Drizzle, Pino, XState, non-major
  GitHub Actions.
- **Supabase updates disabled** (pinned intentionally).
- **pgrx** flagged with a `pgrx` label for careful review (tied to PG major
  version).

---

## 4. Security scanning

**Terminology used in this section:** **Secret scanning** — detects credentials,
API keys, and tokens accidentally committed to source control before they can be
exploited. **SAST (Static Application Security Testing)** — analyses source code
without executing it to find security vulnerabilities such as injection flaws
and unsafe patterns. **SBOM (Software Bill of Materials)** — a machine-readable
inventory of every dependency and transitive dependency in the project, used as
the foundation for vulnerability and licence checks. **SCA (Software Composition
Analysis)** — scans an SBOM against known CVE databases to identify vulnerable
open-source components and flag them by severity.

| Category              | Tool                                                              | Purpose                                                                        | Where                                                            |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Secret scanning       | [**gitleaks**](https://github.com/gitleaks/gitleaks) `v8.30.1`    | Detects committed secrets                                                      | `prek.toml` (local hook) + `.github/workflows/gitleaks.yml` (CI) |
| SAST                  | [**CodeQL**](https://codeql.github.com/)                          | Static analysis of TypeScript + Rust; results in the Security tab              | `.github/workflows/codeql.yml`                                   |
| SBOM generation       | [**CycloneDX cdxgen**](https://github.com/CycloneDX/cdxgen)       | Builds a unified Software Bill of Materials across all 3 ecosystems            | `.github/workflows/sbom.yml`                                     |
| SCA (dependency CVEs) | [**grype**](https://github.com/anchore/grype)                     | Scans the SBOM for known vulnerabilities; fails on High/Critical               | `.github/workflows/sbom.yml`                                     |
| SCA (continuous)      | [**anchore/sbom-action**](https://github.com/anchore/sbom-action) | Submits a dependency snapshot to GitHub's dependency graph → Dependabot alerts | `.github/workflows/sbom.yml`                                     |
| License compliance    | [**REUSE**](https://reuse.software/) (fsfe/reuse-action)          | Verifies every file has SPDX license + copyright                               | `REUSE.toml` + `.github/workflows/reuse.yml`                     |

- `.gitleaks.toml` allowlists the well-known Supabase local-dev demo JWTs (not
  real secrets).
- **DAST:** none configured (no long-running deployed surface to scan yet).

---

## 5. Lint & formatting

Linters and formatters enforce a consistent code style and catch common errors;
each language uses its ecosystem's standard tooling.

| Language        | Tool                                 | Notes                                                                                               |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| TypeScript / JS | **`deno lint`** + **`deno fmt`**     | Built into Deno; enabled in the editor via `.vscode/settings.json` and enforced in CI (`ci.yml`)    |
| Rust            | **`cargo fmt`** + **`cargo clippy`** | Enforced in CI (`ci.yml`, clippy with `-D warnings` on the `pg15` feature)                          |
| Editor-level    | **Prettier**, **ESLint**             | Recommended VS Code extensions (`.vscode/extensions.json`) — editor convenience, not enforced in CI |

---

## 6. Git hooks & pre-commit

| Tool                                     | Purpose                                                             | Config      |
| ---------------------------------------- | ------------------------------------------------------------------- | ----------- |
| [**prek**](https://github.com/j178/prek) | Fast pre-commit hook runner (Rust reimplementation of `pre-commit`) | `prek.toml` |

Currently runs the **gitleaks** hook locally before commits. The same hook runs
in CI via `j178/prek-action@v2` (`.github/workflows/gitleaks.yml`).

---

## 7. Database & infrastructure tooling

These tools manage the local PostgreSQL/Supabase stack, the custom `fsm_core`
Rust extension, and helper scripts for database migrations and seed data.

| Tool                                                               | Purpose                                                    | Where                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| [**Supabase CLI**](https://supabase.com/docs/reference/cli) `2.19` | Local Postgres/Supabase stack, migrations, type generation | `packages/database-src`                    |
| **Docker**                                                         | Container backend for the local Supabase stack             | required by Supabase CLI                   |
| [**pgrx**](https://github.com/pgcentralfoundation/pgrx)            | Rust framework for building the PG extension               | `packages/database-src-extension/fsm_core` |
| **pgmq**                                                           | PostgreSQL message queue (worker execution model)          | PG extension / migrations                  |
| **ltree**                                                          | PostgreSQL tree type (state hierarchy)                     | PG extension / migrations                  |
| **tsx**                                                            | Runs TypeScript helper scripts (versioning, fake users)    | `packages/database-src` npm scripts        |
| **dotenv / dotenv-cli**                                            | Loads `.env` into Node scripts                             | `packages/database-src`                    |

---

## 8. CI/CD pipeline (GitHub Actions)

All workflows live in `.github/workflows/`.

All `uses:` actions are **pinned to commit SHAs** (with a `# vX.Y.Z` comment)
for supply-chain safety; Renovate keeps the digests updated.

| Workflow          | Trigger                                              | Tool(s)                                                                          | Purpose                                                                         |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ci.yml`          | push `main`, PR                                      | `deno fmt/lint/test` + `cargo fmt/clippy`                                        | Lint, format & unit-test gate                                                   |
| `codeql.yml`      | push `main`, PR, weekly cron                         | `github/codeql-action`                                                           | SAST for TypeScript + Rust                                                      |
| `reuse.yml`       | push `main`, PR                                      | `fsfe/reuse-action`                                                              | License/SPDX compliance                                                         |
| `gitleaks.yml`    | push `main`, PR                                      | `j178/prek-action` → gitleaks                                                    | Secret scanning                                                                 |
| `sbom.yml`        | push `main`, PR, release                             | cdxgen + grype + `upload-artifact` + `action-gh-release` + `anchore/sbom-action` | SBOM generation, CVE scan, attach SBOM to releases, dependency-graph submission |
| `cla.yml`         | issue comment, `pull_request_target`                 | `contributor-assistant/github-action`                                            | Contributor License Agreement checks                                            |
| `npm-publish.yml` | tag push (`compiler-v*`/`db-v*`/`worker-v*`), manual | `setup-deno` + `setup-node` + `deno pack` + `npm publish`                        | Publish TS packages to npm                                                      |

> **CI test scope:** `ci.yml` runs only the DB-free unit suites
> (`packages/fsm-compiler-ts`, `apps/fsm-core-ts-hono-deno/stoker-src`). The
> route/db integration tests need a live Postgres + `fsm_core` extension and are
> excluded until a service container is added.

---

## 9. Release & publishing

Publishing is tag-driven; these tools pack TypeScript workspace members, publish
them to npm, and attach the CycloneDX SBOM to GitHub Releases.

| Tool                              | Purpose                                           | Where             |
| --------------------------------- | ------------------------------------------------- | ----------------- |
| **`deno pack`**                   | Packs a Deno workspace member into an npm tarball | `npm-publish.yml` |
| **`npm publish`**                 | Publishes the packed tarball to the npm registry  | `npm-publish.yml` |
| **`softprops/action-gh-release`** | Attaches the CycloneDX SBOM to GitHub Releases    | `sbom.yml`        |

> Releases are tag-driven (`compiler-v*`, `db-v*`, `worker-v*`). Package
> versions for `packages/database-src` are computed by `tsx` scripts
> (`get-next-pkg-version.ts`).

---

## At a glance

| Concern                | Tool                                                  |
| ---------------------- | ----------------------------------------------------- |
| Version pinning        | proto                                                 |
| Dependency management  | Deno, npm, Cargo, pgrx                                |
| Dependency auto-update | Renovate                                              |
| Secret scanning        | gitleaks (via prek)                                   |
| SBOM                   | CycloneDX cdxgen                                      |
| SCA / CVE scan         | grype + GitHub dependency graph (anchore/sbom-action) |
| SAST                   | CodeQL (TS + Rust)                                    |
| License compliance     | REUSE / SPDX                                          |
| Lint & format          | deno lint/fmt, cargo fmt/clippy                       |
| Pre-commit hooks       | prek                                                  |
| Local DB / infra       | Supabase CLI, Docker, pgrx, pgmq, ltree               |
| CI/CD                  | GitHub Actions                                        |
| Publishing             | deno pack + npm publish, action-gh-release            |
