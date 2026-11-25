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

| Tool                                                  | Purpose                                          | Pinned in                                                   |
| ----------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| [**proto**](https://moonrepo.dev/docs/proto/overview) | Pins language/runtime versions                   | Root `.prototools` (packages inherit; may override)         |
| **Deno** `2.9.7`                                      | Primary runtime — API server, compiler, worker   | Root `.prototools`                                          |
| **Node** `26.13.1`                                    | Supabase CLI tooling, npm publish, proto-codegen | Root `.prototools`                                          |
| **npm** `11.21.3`                                     | npm staged publishing via OIDC (needs ≥ 11.21)   | Root `.prototools` (not Node's bundled npm)                 |
| **Rust** `1.99.1`                                     | PostgreSQL extension                             | Root `rust-toolchain.toml` (proto delegates Rust to rustup) |

> Run `proto use` to install the pinned versions. CI (`prek.yml`, `ci.yml`)
> installs from the same files via `moonrepo/setup-toolchain` and a bare
> `rustup toolchain install` — don't hardcode toolchain versions in workflows.

---

## 2. Dependency management (per ecosystem)

Each ecosystem uses its own native package manager; this table records which
tool, manifest, and lockfile apply to each part of the repo.

| Ecosystem    | Tool                            | Manifest / lockfile                      | Location                                   |
| ------------ | ------------------------------- | ---------------------------------------- | ------------------------------------------ |
| Deno / TS    | **Deno** (JSR + npm specifiers) | `deno.json` + `deno.lock`                | repo root (workspace of 8 members)         |
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

| Workflow             | Trigger                                                                                                        | Tool(s)                                                                          | Purpose                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ci.yml`             | push `main`, PR                                                                                                | `deno fmt/lint/test` + `cargo fmt/clippy`                                        | Lint, format & unit-test gate                                                   |
| `codeql.yml`         | push `main`, PR, weekly cron                                                                                   | `github/codeql-action`                                                           | SAST for TypeScript + Rust                                                      |
| `reuse.yml`          | push `main`, PR                                                                                                | `fsfe/reuse-action`                                                              | License/SPDX compliance                                                         |
| `gitleaks.yml`       | push `main`, PR                                                                                                | `j178/prek-action` → gitleaks                                                    | Secret scanning                                                                 |
| `sbom.yml`           | push `main`, PR, release                                                                                       | cdxgen + grype + `upload-artifact` + `action-gh-release` + `anchore/sbom-action` | SBOM generation, CVE scan, attach SBOM to releases, dependency-graph submission |
| `cla.yml`            | issue comment, `pull_request_target`                                                                           | `contributor-assistant/github-action`                                            | Contributor License Agreement checks                                            |
| `pypi-publish.yml`   | tag push (`async-worker-sdk-py-v*`)                                                                            | `setup-python` + `uv build` + `pypa/gh-action-pypi-publish`                      | Publish `pgfsm-async-worker-sdk` to PyPI                                        |
| `crates-publish.yml` | tag push (`async-worker-sdk-rs-v*`)                                                                            | `cargo test` + `cargo publish`                                                   | Publish the `pgfsm-async-worker-sdk` crate to crates.io                         |
| `go-publish.yml`     | tag push (`async-worker-sdk-go-v*`)                                                                            | `go test` + `git tag` + Go module proxy                                          | Release the `fsm-async-worker-sdk-go` Go module                                 |
| `npm-publish.yml`    | tag push (`compiler-v*`/`cli-v*`/`ctl-v*`/`db-v*`/`sync-worker-v*`/`async-worker-sdk-v*`/`logging-v*`), manual | `setup-toolchain` + dnt / `deno pack` + `npm stage publish` (OIDC)               | Stage TS packages on npm; a maintainer approves (see below)                     |

> **CI test scope:** `ci.yml` runs only the DB-free unit suites
> (`packages/fsm-compiler-ts`, `packages/fsm-api-ts/stoker-src`), plus
> `packages/fsm-async-worker-sdk-python`'s pytest suite via `uv` and
> `packages/fsm-async-worker-sdk-rust`'s `cargo test`/`clippy` and
> `packages/fsm-async-worker-sdk-go`'s `go vet`/`go test -race`. The route/db
> integration tests need a live Postgres + `fsm_core` extension and are excluded
> until a service container is added.

---

## 9. Release & publishing

Publishing is tag-driven; these tools pack TypeScript workspace members, publish
them to npm, and attach the CycloneDX SBOM to GitHub Releases.

| Tool                              | Purpose                                           | Where             |
| --------------------------------- | ------------------------------------------------- | ----------------- |
| **`deno pack`**                   | Packs a Deno workspace member into an npm tarball | `npm-publish.yml` |
| **`npm stage publish`**           | Stages the package on npm for approval (#719)     | `npm-publish.yml` |
| **`softprops/action-gh-release`** | Attaches the CycloneDX SBOM to GitHub Releases    | `sbom.yml`        |

> Releases are tag-driven (`compiler-v*`, `cli-v*`, `ctl-v*`, `db-v*`,
> `sync-worker-v*`, `async-worker-gateway-v*`, `async-worker-sdk-v*`). Package
> versions for `packages/database-src` are computed by `tsx` scripts
> (`get-next-pkg-version.ts`).

### npm releases: trusted publishing + staged approval (#719)

No workflow holds an npm token. Each npm job authenticates with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) (GitHub OIDC,
`permissions: id-token: write`) and runs `scripts/npm-stage-publish.sh`, which
runs `npm stage publish` (npm >= 11.21, pinned in `.prototools`). A staged
version is **not installable** until a maintainer approves it with 2FA:

```bash
npm stage list @pgfsm/<pkg>          # find the stage id
npm stage approve <stage-id>         # prompts for 2FA; the version goes live
```

or approve on the package's page on npmjs.com (several at once, one 2FA prompt).
Approve a dependency before its dependents: `@pgfsm/compiler` before
`@pgfsm/cli`, `@pgfsm/proto-codegen` before `@pgfsm/async-worker-sdk`,
`@pgfsm/db`/`@pgfsm/logging` before `@pgfsm/api`/`@pgfsm/async-worker-gateway`.
`api-release.yml` and `gateway-release.yml` wait up to 30 minutes for the
approval before tagging the image; after that, approve and re-run the failed
jobs. The OIDC identity can't list staged versions, so re-running a release
whose version is staged but unapproved fails at the stage step: approve (or
`npm stage reject`) the staged one instead.

**One-time setup per package** (npmjs.com → package → Settings → Trusted
publishing → GitHub Actions): organization `pgfsm`, repository `fsm`, the
workflow filename below, no environment. Under _Allowed actions_ leave
`npm publish` **off** (stage-only), so CI can never release without an approval.
A new trusted publisher must publish within 2 days of being created, and it
can't be edited (delete and recreate it instead). The built `package.json` must
have `repository.url` = this repo; every `build-npm.ts` and the `deno pack` jobs
set it.

| Workflow file         | Packages                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm-publish.yml`     | `@pgfsm/compiler`, `@pgfsm/cli`, `@pgfsm/ctl`, `@pgfsm/db`, `@pgfsm/sync-worker`, `@pgfsm/async-worker-sdk`, `@pgfsm/logging` |
| `proto-publish.yml`   | `@pgfsm/proto-codegen`, `@pgfsm/proto-codegen-sync`                                                                           |
| `gateway-release.yml` | `@pgfsm/async-worker-gateway`                                                                                                 |
| `api-release.yml`     | `@pgfsm/api`                                                                                                                  |

A package that isn't on npm yet (`@pgfsm/cli`, `@pgfsm/ctl` and `@pgfsm/api` as
of #719, `@pgfsm/proto-codegen-sync` as of #736) may have no settings page to
add the trusted publisher to. If so, stage its first version by hand:
`npm login`, `deno task build:npm <version>
--copy-readme` in the package, then
`npm stage publish --access public` from its `dist/`. That creates the package
(npm shows a public `0.0.0-stage` placeholder until approval). Then add the
trusted publisher and approve.

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
