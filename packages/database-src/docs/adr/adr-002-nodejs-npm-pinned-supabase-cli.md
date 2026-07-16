# ADR-002: Node.js + npm, with a Pinned `supabase` CLI Version, for `database-src`

**Status:** Accepted **Date:** 2026-07-16

---

## Context

Every other Deno-capable package in this monorepo runs on Deno
(`apps/fsm-core-ts-hono-deno`, `apps/fsm-core-worker-ts`,
`packages/fsm-core-db-ts`, `packages/fsm-compiler-ts`,
`packages/fsm-logging-ts`). `packages/database-src` is the one exception: it's
pinned to Node 22.16.0 via its own `.prototools` and driven entirely by npm
(`package.json` + `package-lock.json`), as already noted in the root
`CLAUDE.md`.

The reason is the Supabase CLI. Local Supabase dev (`supabase start`/`stop`,
`supabase db diff`, `supabase gen types`) and PGXN packaging all depend on the
`supabase` binary. Supabase officially distributes this CLI as an **npm
package** (`supabase` on the npm registry) that installs a platform-specific
native binary into `node_modules/.bin/supabase`, resolved and locked via the
ordinary npm dependency mechanism (`package.json`'s `"supabase": "2.19"` +
`package-lock.json`'s resolved integrity hash). `npm install` reproduces the
exact same CLI binary version for every contributor and in CI, with no manual
install step.

Deno's `npm:` specifier support can resolve npm packages too, but there is no
equivalent "install a pinned CLI binary into a well-known, locked local path"
workflow for it the way `node_modules/.bin` + `package-lock.json` provides —
Deno's npm compat is designed around importing modules into TypeScript code, not
vendoring a versioned native CLI binary for repeated shell invocation. Node/npm
is the natural fit for _consuming_ a CLI tool that itself ships as an npm
package.

### Incident that reinforced this

While adding a Deno-native orchestration script
(`supabase-restart-with-diff.ts`, [ADR context: same package]) that shells out
to `supabase` via `Deno.Command`, the script called the bare command name
`"supabase"`. This is exactly what the existing npm scripts in `package.json`
also do (e.g. `"supabase:stop": "supabase stop"`) — but `npm
run` transparently
prepends `node_modules/.bin` to `PATH` for every script it executes, so a bare
`supabase` inside an npm script always resolves to the project-pinned binary.
`Deno.Command` has no such `PATH` mangling; it inherits the caller's actual
shell `PATH` verbatim.

On the development machine this exposed a real version skew:

| Resolution                      | Version | Source                                       |
| ------------------------------- | ------- | -------------------------------------------- |
| `node_modules/.bin/supabase`    | 2.19.8  | pinned by `package.json`/`package-lock.json` |
| bare `supabase` on shell `PATH` | 1.131.5 | global Homebrew install                      |

Running against the stale global v1.131.5 produced two concrete failures:

1. `Unknown config fields: [...]` — a long list of `config.toml` fields (added
   in newer CLI versions) that v1.131.5 doesn't recognize.
2. `supabase db diff` behaved differently: it attempted to connect to a
   presumed-running local Postgres at `127.0.0.1:54322` and failed with
   `connection refused`, instead of the declarative-schema diff behavior
   expected from the pinned v2.19 line.

The fix was to resolve `node_modules/.bin/supabase` explicitly in the Deno
script rather than relying on `PATH`, reproducing what `npm run` already did
implicitly for the npm scripts. This incident is direct evidence for why the CLI
version must be pinned and explicitly resolved, not left to whatever happens to
be first on a given machine's `PATH`.

---

## Decision

1. `packages/database-src` continues to use **Node.js + npm** (not Deno) as its
   primary tooling runtime, specifically because the Supabase CLI's canonical,
   version-pinnable distribution channel is npm.
2. The `supabase` CLI version stays **pinned in `package.json`**
   (`"supabase": "2.19"`, locked further by `package-lock.json`) rather than
   relying on a system/global install.
3. **Any** tooling that shells out to `supabase` — npm scripts or the Deno
   orchestration script — must resolve the project-pinned binary
   (`node_modules/.bin/supabase`) explicitly rather than a bare `supabase`
   looked up on `PATH`, since only `npm run` (not `Deno.Command`, not a plain
   shell) prepends `node_modules/.bin` automatically.
4. Adding a `deno.json` to this package (for a Deno-native orchestration script)
   does not change this — Deno is additive tooling on top of the npm-managed CLI
   dependency, not a replacement for it.

---

## Consequences

### Positive

- Every contributor and CI run gets the exact same `supabase` CLI version via
  `npm install`, with no manual global-install step and no drift between
  machines.
- `package-lock.json` makes the pin auditable and reproducible — upgrading the
  CLI is a deliberate `package.json` version bump, not an implicit side-effect
  of someone running `brew upgrade`.
- The failure mode this ADR documents (silent version skew via `PATH`) is now a
  known, named hazard — future scripts in this package that invoke `supabase`
  can be reviewed against rule 3 above.

### Negative / Trade-offs

- Any new script (Deno, shell, or otherwise) that calls `supabase` must remember
  to resolve `node_modules/.bin/supabase` explicitly; forgetting this
  reintroduces the exact PATH-drift hazard described above, and the failure mode
  (config warnings, altered `db diff` behavior) is not obviously attributable to
  a version mismatch from the error output alone.
- Keeps this one package on a different runtime (Node) than the rest of the
  monorepo, which is a documented but ongoing asymmetry (see `CLAUDE.md`).

---

## Alternatives Considered

| Option                                                                                   | Why Not Selected                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rely on a globally-installed `supabase` CLI (Homebrew, curl installer)                   | No version pin, no lockfile, no reproducibility across contributors/CI. This is precisely the failure mode observed in the incident above (stale global v1.131.5 vs. pinned v2.19.8).                                                                                         |
| Consume `supabase` purely via Deno's `npm:` specifier, drop npm entirely                 | Deno's npm compat targets importing modules into TS code; it does not provide the "installed pinned binary in a well-known local path" model that shelling out to a CLI tool needs. npm/`node_modules/.bin` remains the right mechanism for this specific dependency shape.   |
| Call `npx supabase@2.19` from the Deno script instead of resolving the local binary path | Works, but re-resolves/re-verifies the package from the npm registry (or global npx cache) on every invocation rather than using the already-installed, lockfile-verified local binary; slower and adds an implicit network/cache dependency for something already installed. |

---

## Sources

- Supabase CLI npm package: https://www.npmjs.com/package/supabase
- `packages/database-src/package.json` — `"supabase": "2.19"` dependency pin
- `packages/database-src/supabase-restart-with-diff.ts` —
  `SUPABASE_BIN = join(SCRIPT_DIR, "node_modules/.bin/supabase")`
