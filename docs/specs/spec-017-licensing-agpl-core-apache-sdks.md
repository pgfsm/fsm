# SPEC-017: Licensing — AGPL-3.0-only Engine, Apache-2.0 SDKs

| Field   | Value                                                                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Accepted (legal review pending, #707)                                                                                                                                                                                                                                  |
| Date    | 2026-11-21                                                                                                                                                                                                                                                             |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                                                                                                               |
| Issue   | #703                                                                                                                                                                                                                                                                   |
| Affects | Licence metadata repo-wide: `REUSE.toml`, `LICENSES/`, `LICENSE`, `NOTICE`, `README.md`, `CONTRIBUTING.md`; every package's manifest and `LICENSE` file; `packages/database-src` (PGXN `META.json`, SQL artifacts); the API and Gateway release workflows (OCI labels) |

Related: SPEC-016 (installation and distribution: where the engine's artifacts
ship), `CLA.md`.

> This spec records a licensing decision; it is not legal advice. A lawyer
> reviews the final texts (`COMMERCIAL.md`, `TRADEMARKS.md`, the per-path split)
> before #707 merges; the spec was accepted with that review pending.

---

## Problem

Everything in `pgfsm/fsm` is Apache-2.0 (`LICENSE`, `REUSE.toml`'s catch-all
annotation). That permits anyone to:

- ship a **closed, modified engine** (fsm_core, the API, the Activity Gateway)
  without sharing their changes;
- **run a modified engine as a hosted service** without sharing their changes;
- **publish a fork under the pgfsm name**: Apache-2.0 §6 grants no trademark
  rights, but nothing in the repo states a trademark policy either.

We want pgfsm to stay **OSI open source** while requiring that modified engines,
distributed or offered over a network, share their source, and to keep a path to
a commercial licence for organisations that can't accept that. Users' own code
(actions, guards, async actors, generated projects) must stay free of copyleft,
or adoption stops.

It is now because the first engine release under SPEC-016 (fsm_core 1.2.0) has
just shipped. Every further Apache-2.0 engine release is one more version that
stays Apache-2.0 forever.

The licence metadata is also inconsistent today: `@pgfsm/db`, `@pgfsm/logging`
and `@pgfsm/async-worker-old` declare `MIT` in `deno.json` and in
`scripts/build-npm.ts` (so their npm pages say MIT), while their `LICENSE` files
and `REUSE.toml` say Apache-2.0.

## Constraints

- **Already-released versions stay Apache-2.0.** The grant is irrevocable:
  fsm_core 1.2.0 and every published npm, PyPI and crates.io version and Go
  module tag. This spec only governs versions released after it lands. The three
  packages whose published versions declare MIT stay available under MIT for
  those versions.
- **We can relicense.** `CLA.md` §2 grants the project a perpetual, irrevocable
  copyright licence to contributions, _including the right to sublicense_, which
  covers both AGPL-3.0 and a commercial licence. Git history has no human author
  other than the maintainer (plus `renovate[bot]`).
- **Users' code must not inherit copyleft.** Anything that runs in the user's
  process, is linked by it, or is copied into it stays permissive.
- **Licence compatibility goes one way.** Apache-2.0 code can be combined into
  an AGPL-3.0 work (for example `@pgfsm/api` importing `@pgfsm/db`), but AGPL
  code can't go into an Apache-2.0 package. So no Apache-2.0 package may depend
  on an AGPL package.
- **REUSE compliance stays green.** CI runs `reuse lint`, so every file keeps a
  declared licence; per-path annotations in `REUSE.toml` carry the split.
- **No ADR conflicts.** ADR-001 to 003 and the package ADRs don't address
  licensing.
- **Distribution channels don't change.** npm, PyPI, crates.io, Go module tags,
  GHCR and the fsm_core release (SPEC-016) stay as they are; only the licence
  metadata they carry changes.

## Options considered

### Option A — Stay Apache-2.0, add a trademark policy

Keep everything permissive; protect only the name.

- Pros: no adoption friction; no metadata change beyond fixing the MIT drift;
  maximally compatible.
- Cons: doesn't address the problem. Closed forks and hosted modified engines
  stay allowed. A trademark only stops reuse of the name, not of the code.

### Option B — AGPL-3.0 for the whole repository

One licence everywhere.

- Pros: the simplest metadata; the strongest protection.
- Cons: the SDKs, `@pgfsm/sync-worker`, `@pgfsm/db`, the compiler's generated
  code and the CLI's templates all run in, link into, or get copied into users'
  code. Many legal teams treat that as making the user's program a combined AGPL
  work, which would block adoption at most companies. That fails the "users'
  code stays free" constraint.

### Option C — AGPL-3.0-only engine, Apache-2.0 for everything user code touches (chosen)

Split by one rule: **is the component reached only over a protocol, or does user
code run in, link, or copy it?** The first is AGPL-3.0-only; the second is
Apache-2.0. Add a commercial licence for the engine (reserved, not priced yet)
and a trademark policy.

- Pros: protects exactly the parts worth protecting. Each one is a separate
  service users talk to over Postgres, HTTP or TCP, so users' code is never
  combined with them. It stays OSI open source. The commercial licence gives
  AGPL-averse organisations a path. It matches common practice for company-led
  open-core projects (Grafana, MinIO, Mattermost).
- Cons: two licences to keep straight in metadata, needing per-path REUSE
  annotations and a CI check. Some organisations ban AGPL outright even for
  unmodified services. It doesn't stop a vendor hosting the _unmodified_ engine
  as a service.

### Option D — Source-available (FSL-1.1-Apache-2.0, BSL 1.1, ELv2, SSPL)

A licence that forbids offering the software as a competing service, often
converting to Apache-2.0 after a delay (FSL: 2 years).

- Pros: the only option here that also stops hosting of the _unmodified_ engine.
- Cons: not open source by the OSI definition, which fails the main requirement.
  Recent switches to these licences drew community forks (HashiCorp → OpenTofu,
  Redis → Valkey), and Elastic and Redis later added AGPL options back.

### Option E — MPL-2.0 for the engine

File-level copyleft: changes to MPL files must be shared when distributed.

- Pros: OSI open source and easy for companies to accept.
- Cons: no network clause. A modified engine run as a hosted service doesn't
  have to share anything, which is the main case we want to cover.

## Decision

**Option C.** Decision drivers:

1. **OSI open source is non-negotiable**, which rules out D.
2. **The hosted-service case must share modifications.** Only AGPL's §13 covers
   it, which rules out A and E.
3. **Users' code stays permissive**, which rules out B. The engine/embedded line
   falls naturally at the protocol boundary pgfsm already has: users reach
   fsm_core over Postgres, the API over HTTP and the Gateway over TCP.

### The split

| Component                                                                                        | Path                                                                                                                                      | Licence       | Why                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| fsm_core (SQL schema, migrations, install SQL, PGXN bundle, build scripts)                       | `packages/database-src/`, except the contract files below                                                                                 | AGPL-3.0-only | Engine; reached over the Postgres protocol. FSM definitions are loaded into it as data.                |
| fsm_core's public contract: the FSM JSON schemas and the generated type descriptions             | `packages/database-src/fsm.machine.schema.*.json`, `packages/database-src/xstate.machine.schema.json`, `packages/database-src/generated/` | Apache-2.0    | The interface users write `fsm.json` against; `@pgfsm/db` and `@pgfsm/compiler` import and ship these. |
| fsm_core pgrx extension                                                                          | `packages/database-src-extension/`                                                                                                        | AGPL-3.0-only | Another form of the engine.                                                                            |
| `@pgfsm/api` (+ GHCR image, k8s manifests)                                                       | `packages/fsm-api-ts/`                                                                                                                    | AGPL-3.0-only | Engine service; reached over HTTP.                                                                     |
| Activity Gateway `@pgfsm/async-worker-gateway` (+ GHCR image)                                    | `packages/fsm-async-worker-gateway-ts/`                                                                                                   | AGPL-3.0-only | Engine service; async actors reach it over TCP.                                                        |
| Async-worker SDKs (TS, Python, Rust, Go)                                                         | `packages/fsm-async-worker-sdk-*/`                                                                                                        | Apache-2.0    | Linked into users' async actors.                                                                       |
| Proto contracts and generated stubs                                                              | `packages/fsm-proto-codegen/`                                                                                                             | Apache-2.0    | Linked into users' actors in every language.                                                           |
| `@pgfsm/sync-worker` (fsmlet runtime)                                                            | `packages/fsm-sync-worker-ts/`                                                                                                            | Apache-2.0    | Runs in the user's process; their sync actions and guards execute inside it.                           |
| `@pgfsm/db`                                                                                      | `packages/fsm-core-db-ts/`                                                                                                                | Apache-2.0    | Linked by `@pgfsm/sync-worker` and by users; **fixes the MIT declaration**.                            |
| `@pgfsm/logging`                                                                                 | `packages/fsm-logging-ts/`                                                                                                                | Apache-2.0    | Linked by the above; **fixes the MIT declaration**.                                                    |
| `@pgfsm/compiler`                                                                                | `packages/fsm-compiler-ts/`                                                                                                               | Apache-2.0    | Its generated code is copied into users' projects.                                                     |
| `@pgfsm/cli`                                                                                     | `packages/fsm-cli-ts/`                                                                                                                    | Apache-2.0    | Generates users' projects; its templates become user code.                                             |
| `@pgfsm/ctl` (`pgfsmctl`)                                                                        | `packages/fsm-ctl-ts/`                                                                                                                    | Apache-2.0    | An API client users run and script against.                                                            |
| `@pgfsm/async-worker-old` (deprecated v1)                                                        | `packages/fsm-async-worker-ts/`                                                                                                           | Apache-2.0    | Frozen, never released again; **fixes the MIT declaration** to match its `LICENSE` file.               |
| Examples, test apps, docs, repo tooling (`apps/`, `test-apps/`, `docs/`, `scripts/`, `.github/`) | —                                                                                                                                         | Apache-2.0    | Users copy from examples; tooling isn't the engine.                                                    |

Because no Apache-2.0 package may depend on an AGPL one, the dependency
direction is fixed: the engine may import `@pgfsm/db` and `@pgfsm/logging`, but
no _shipped_ Apache-2.0 code imports AGPL-3.0-only files. Today two edges cross
into `packages/database-src/`, and both reach contract files that the table
above keeps Apache-2.0:

- `@pgfsm/db` (`src/database.types.ts`) imports
  `database-src/generated/database.types.ts`;
- `@pgfsm/compiler` imports `database-src/fsm.machine.schema.v3.json`
  (`src/generate-fsm-json.ts`) and
  `database-src/generated/fsm-machine-schema.types.ts` (`src/types/index.ts`).

Tests are not distributed, so test-only use of the engine is fine: the
`@pgfsm/async-worker-sdk` tests start a real Gateway in-process, the
`@pgfsm/ctl` tests start the API, and the `@pgfsm/cli` tests and `compose-e2e`
build the engine images. CI keeps the direction (see Acceptance criteria) and
checks only shipped code: each package's `src/` and whatever its
`scripts/build-npm.ts` bundles.

### Details

- **Identifier: `AGPL-3.0-only`**, not `-or-later`. The project, not the FSF,
  decides whether a future AGPL version applies; the CLA keeps relicensing open.
- **Cutover:** the first release of each engine component after this spec is
  implemented is AGPL-3.0-only, as a **minor** bump: fsm_core 1.3.0 (or the
  first minor after 1.2.x) and the next minor of `@pgfsm/api` and the Gateway. A
  licence change isn't an API change, and an fsm_core major bump would make
  `@pgfsm/db`'s startup check refuse it (same-major rule) for no benefit. Each
  release note states "licence: AGPL-3.0-only from this version; earlier
  versions remain Apache-2.0". No empty releases are needed: the licence change
  rides along with the next real release of each component. **Amended in #710:**
  fsm_core 1.2.0's release never completed, so no fsm_core was ever published
  under Apache-2.0. 1.2.0, the baseline everything on `main` already requires
  (`FSM_CORE_MIN_VERSION`), is fsm_core's first release and is AGPL-3.0-only;
  its release note says so without the "earlier versions" line.
- **Commercial licence (reserved):** a short `COMMERCIAL.md` says that the
  engine is available under a commercial licence for organisations that can't
  accept the AGPL, and gives a contact. It doesn't include terms or pricing.
  `README.md` and `NOTICE` link to it.
- **Trademark policy:** `TRADEMARKS.md` states that "pgfsm" and "fsm_core" are
  the project's trademarks. Modified distributions and forks must use a
  different name, and nominative use ("compatible with pgfsm") is fine. `NOTICE`
  links to it. Registering the marks is outside the repo and outside this spec.
- **Helping AGPL §13:** §13 obliges whoever runs a _modified_ engine to offer
  its source to network users. To make that easy, the API's version endpoint (or
  its OpenAPI `info`) and the Gateway's startup log report `AGPL-3.0-only` and a
  source URL. Someone who modifies the engine replaces the URL with their own.
  The fsm_core install SQL carries an SPDX header.

## Consequences & migration

**What gets harder**

- Two licences to keep straight. Per-path `REUSE.toml` annotations replace the
  single catch-all, and a CI check stops a manifest, `LICENSE` file or
  `build-npm.ts` from drifting from its path's licence (the MIT drift shows it
  happens).
- Some organisations ban AGPL even for unmodified services they only run. The
  commercial licence is the answer for them, and evaluation and self-hosting of
  the unmodified engine stay fully allowed under the AGPL.
- Outside contributions to the engine are relicensable only because of the CLA,
  so the CLA requirement becomes essential rather than a formality.

**Migration** (implementation issues, after acceptance)

1. **Licence files and REUSE:** add `LICENSES/AGPL-3.0-only.txt`; replace the
   catch-all in `REUSE.toml` with per-path annotations matching the table; give
   each engine package an AGPL `LICENSE`; add the missing `LICENSE` files
   (`fsm-logging-ts`, `fsm-cli-ts`, `database-src`, the proto `gen/` packages);
   update the root `LICENSE`/`NOTICE` to explain the split.
2. **Package metadata:** set `license` in every `deno.json`, `package.json`,
   `Cargo.toml`, `pyproject.toml` and `scripts/build-npm.ts` per the table
   (including the three MIT → Apache-2.0 fixes); set the OCI
   `org.opencontainers.image.licenses` annotation to `AGPL-3.0-only` in
   `api-release.yml` and `gateway-release.yml`; add `agpl-3.0-only → agpl_3` to
   `SPDX_TO_PGXN` in `build-both-pgext-and-fullsqlscript.ts`.
3. **Docs:** `COMMERCIAL.md`, `TRADEMARKS.md`; the README licence badge and a
   licence section showing the split; the `CONTRIBUTING.md` licence section;
   each engine package's README.
4. **AGPL notices:** an SPDX header in the fsm_core SQL artifacts; the licence
   and source URL in the API's version/OpenAPI info and the Gateway's startup
   log.
5. **CI guard:** a check that each package's declared licence (manifest,
   `build-npm.ts`, `LICENSE` file) matches its REUSE path annotation, and that
   no Apache-2.0 package imports an AGPL package.
6. **Releases:** the next fsm_core, `@pgfsm/api` and Gateway releases carry the
   change and its release note; the next releases of `@pgfsm/db` and
   `@pgfsm/logging` carry the MIT → Apache-2.0 fix.

**Rollback:** relicensing towards _more_ permissive terms is always possible.
The CLA lets the project release later versions under Apache-2.0 again, and it
can even re-offer the AGPL versions under Apache-2.0. The one thing that can't
be undone is the reverse: versions already released under Apache-2.0 stay
Apache-2.0.

## Acceptance criteria

- [ ] `reuse lint` passes, with `REUSE.toml` annotating `AGPL-3.0-only` exactly
      for `packages/database-src/` (minus its contract files: the FSM JSON
      schemas and `generated/`), `packages/database-src-extension/`,
      `packages/fsm-api-ts/` and `packages/fsm-async-worker-gateway-ts/`, and
      `Apache-2.0` for everything else; `LICENSES/` contains both texts.
- [ ] Every package's manifest `license` field, `scripts/build-npm.ts` `license`
      and `LICENSE` file match the table. No package declares `MIT` any more.
- [ ] A CI check fails when a package's declared licence differs from its REUSE
      annotation, or when shipped Apache-2.0 code (`src/` or what `build-npm.ts`
      bundles) imports an AGPL-3.0-only file; it passes on today's `@pgfsm/db`
      and `@pgfsm/compiler` imports of the contract files.
- [ ] The API and Gateway GHCR images carry
      `org.opencontainers.image.licenses=AGPL-3.0-only`.

<!-- REUSE-IgnoreStart -->

- [ ] The fsm_core PGXN `META.json` declares `agpl_3`, and the fsm_core install
      SQL starts with an `SPDX-License-Identifier: AGPL-3.0-only` header.

<!-- REUSE-IgnoreEnd -->

- [ ] The API reports its licence and a source URL (version endpoint or OpenAPI
      `info`), and the Gateway logs them at startup.
- [ ] `COMMERCIAL.md` and `TRADEMARKS.md` exist and are linked from `README.md`
      and `NOTICE`; the README badge and licence section show the split;
      `CONTRIBUTING.md` describes which licence a contribution is under per
      path.
- [ ] The first AGPL releases of fsm_core, `@pgfsm/api` and the Gateway are
      minor bumps, and their release notes state the change and that earlier
      versions remain Apache-2.0.
- [ ] A lawyer has reviewed `COMMERCIAL.md`, `TRADEMARKS.md` and the per-path
      split before #707 merges (accepted with this review pending).

### Open questions

- ~~The contact address `COMMERCIAL.md` gives (personal email or a dedicated
  alias).~~ Resolved in #707: the dedicated alias `licensing@pgfsm.dev`.
- Whether `test-apps/` should carry an explicit "examples, copy freely" note in
  addition to Apache-2.0.

## Implementation

Accepted on 2026-11-21 (#704) with the legal review still open: the lawyer's
review of `COMMERCIAL.md`, `TRADEMARKS.md` and the per-path split is tracked in
#707, and #707 doesn't merge until it's done.

| Issue | Scope                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| #705  | `LICENSES/AGPL-3.0-only.txt`, per-path `REUSE.toml` annotations, per-package `LICENSE` files, root `LICENSE`/`NOTICE` |
| #706  | Licence fields in manifests and `build-npm.ts` (MIT → Apache-2.0 fix), OCI image labels, PGXN `agpl_3`                |
| #707  | `COMMERCIAL.md`, `TRADEMARKS.md`, README and `CONTRIBUTING.md` licence docs; the legal review                         |
| #708  | AGPL notices: SPDX header in the fsm_core SQL, licence and source URL in the API and the Gateway                      |
| #709  | CI check: declared licences match REUSE; shipped Apache-2.0 code imports no AGPL file                                 |
| #710  | First AGPL engine releases (minor bumps) and the `@pgfsm/db`/`@pgfsm/logging` licence-fix releases                    |
