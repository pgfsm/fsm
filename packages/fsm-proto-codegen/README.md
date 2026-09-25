# @pgfsm/proto-codegen

Buf-driven `.proto` → multi-language stub generation for this repo's four
polyglot actor languages (TypeScript, Python, Rust, Go), and the source-of-truth
home for the `.proto` contracts themselves (see
[SPEC-002](../../docs/specs/spec-002-proto-contracts-in-codegen-package.md)).

## Why this exists

`activity_gateway.proto` (the Activity Gateway's client-facing gRPC contract)
had no generated stubs at all: TypeScript used `@grpc/proto-loader` at runtime
(schema reflection, no codegen), and there was no Python/Rust/Go client or
server code for it. Rather than hand-writing or hand-porting stubs per language
the way the old `fsm-core-async-op-worker/src/worker-sdk/` once was, this
package runs each service's `.proto` files through [Buf](https://buf.build)'s
plugin pipeline for all four languages from a single `buf generate` command.

Wiring the generated stubs into the actual gateway/worker code (replacing
`@grpc/proto-loader` etc.) is deliberately **not** part of this package — see
[#86](https://github.com/pgfsm/fsm/issues/86). This package only proves the
codegen pipeline works and produces correct, runnable output.

## Layout

- `proto/<service>/` — one directory per service that defines `.proto`
  contracts, e.g. `proto/fsm-core-async-op-worker/` for the Activity Gateway and
  Sidecar Gateway contracts. Each is its own independent Buf module: its own
  `buf.yaml` (lint/breaking-change policy), scoped to that service alone.
  Centralizing here is about _location_, not _governance_ — one service's lint
  exceptions or breaking-change policy never leak onto another's. See
  [SPEC-002](../../docs/specs/spec-002-proto-contracts-in-codegen-package.md)
  for the full rationale and the "one shared module" alternative it rejects.
- `local.buf.gen.yaml` / `remote.buf.gen.yaml` / `hybrid.buf.gen.yaml` (this
  package) — three codegen _plugin_ configs, same `inputs:`/output layout,
  different plugin sources: see [Regenerating](#regenerating) for which to use.
  `inputs:` lists one entry per service directory above.
- `gen/{typescript,python,rust,go}/` — generated output, committed (same
  convention as this monorepo's own `apps/async-worker/`, see #316) so consumers
  don't need Buf installed just to build against it. Each carries its own
  hand-written package manifest giving the generated stubs a real package
  identity for that language's toolchain — `gen/typescript/deno.json` (`exports`
  map + the `imports` map generated code needs to resolve `@bufbuild/protobuf`
  at runtime), `gen/rust/Cargo.toml`, `gen/python/pyproject.toml`,
  `gen/go/go.mod` — same convention across all four, see #106. Each also has a
  hand-written `README.md` used as its registry page; all four are published,
  see [Publishing](#publishing).
- `package.json` / `node_modules/` (package root) — **not** app dependencies,
  and **not** where consumers import from. The npm-managed half of the
  toolchain: the `buf` CLI itself plus the two `protoc-gen-*` binaries needed on
  `PATH` for TypeScript's `local:` plugins (used by both `local.buf.gen.yaml`
  and `hybrid.buf.gen.yaml`), run via `npm run generate:local` /
  `npm run
  generate:remote` / `npm run generate:hybrid`. Consumers import from
  `gen/typescript/deno.json`'s `exports`, not this file.

### Adding a new service's contracts

1. Create `proto/<service-name>/` with its own `buf.yaml` (copy an existing
   service's as a starting point) and `.proto` files under it.
2. Add an entry to **all three** of `local.buf.gen.yaml`'s,
   `remote.buf.gen.yaml`'s, and `hybrid.buf.gen.yaml`'s `inputs:` list pointing
   at that directory — the existing `plugins:` list in each applies to every
   input, so no other change is needed to generate all four languages for it
   too.
3. `npm run generate:local` (see [Regenerating](#regenerating)), then commit the
   new `proto/<service-name>/` and its `gen/` output together.

The service itself still implements and calls its contract as before — only the
`.proto` source and its buf module move here.

## Regenerating

Three templates produce the same `gen/` layout from different plugin sources —
see [Plugins, per language](#plugins-per-language) for why all three exist and
which one to actually run:

```sh
cd packages/fsm-proto-codegen
npm install                          # once, or after pulling a version bump

npm run generate:local:docker        # canonical — what CI checks gen/ against, see below
npm run generate:local               # local.buf.gen.yaml on the host (gen/python caveat, see below)
npm run generate:remote              # BSR only, no local toolchain needed
npm run generate:hybrid              # TS local + Python/Rust/Go remote
```

**`generate:local:docker` is the canonical generator.** CI's
[`proto-codegen` workflow](../../.github/workflows/proto-codegen.yml) rebuilds
the same image, regenerates, and fails the PR if `gen/` differs from what's
committed — so commit exactly what `generate:local:docker` produces, in the same
PR as the `.proto` change. CI never commits generated code itself.

All four are plain `npm run` scripts (`package.json`'s `scripts:`); the first
three run `buf` directly, so `buf` itself and TypeScript's two `protoc-gen-*`
plugins resolve automatically from `node_modules/.bin` — no manual `PATH` export
needed. `local.buf.gen.yaml` additionally needs Python/Rust/Go's local plugin
binaries on `PATH` — those aren't npm packages, see
[Local plugin install](#local-plugin-install). `generate:hybrid` needs none of
those, since its Python/Rust/Go entries are `remote:`, same as
`generate:remote`. `generate:local:docker` needs none of them on the host either
— see [Regenerating with Docker](#regenerating-with-docker).

`generate:remote` and `generate:hybrid` both produce working output for every
language now (see below), but still expect diff noise if you run either:
`gen/rust/` comes back reformatted to BSR's older `prost-build` whitespace
style, and (for `generate:remote` only, since `generate:hybrid`'s TS entries are
`local:`) TypeScript's generated-by-version banner comments say
`v1.10.0`/`v1.6.1` instead of `local.buf.gen.yaml`'s `v1.10.1`/`v1.7.0`
(cosmetic either way — see below — but not something to commit over the local
output). If you've run either and don't intend to commit the result, discard it:

```sh
git checkout -- gen/typescript/ gen/rust/
```

## Plugins, per language

`local.buf.gen.yaml` runs every plugin from a locally-installed binary (no BSR
call, reproducible regardless of BSR's availability or what "latest" resolves
to); `remote.buf.gen.yaml` runs every plugin from BSR
(`buf.build/<owner>/<plugin>`, no local install needed); `hybrid.buf.gen.yaml`
splits the difference, TypeScript's plugins from `local.buf.gen.yaml` and
Python/Rust/Go's from `remote.buf.gen.yaml`. All three now produce correct
output for every language — pick based on which toolchain cost you're avoiding:

- No `protoc`/`grpc_python_plugin`/`cargo`/`go` on `PATH` at all, and don't mind
  BSR resolving whatever it last published? → `remote.buf.gen.yaml`.
- Want exact version control without installing Python/Rust/Go's local plugins
  (npm already gets you TypeScript's)? → `hybrid.buf.gen.yaml`.
- Full exact version control, every language, no BSR dependency, but also no
  local Go/Rust/`protoc`/`grpc` installs? → `npm run generate:local:docker` —
  same plugin versions as `local.buf.gen.yaml`, containerized. The default
  recommendation: it's what's committed under `gen/` today and what CI checks
  against — see [Regenerating with Docker](#regenerating-with-docker).
- Full exact version control, every language, no BSR dependency, no Docker
  either? → `local.buf.gen.yaml` on the host — matches the committed output
  except `*_pb2_grpc.py` (Homebrew's newer `grpc_python_plugin`), which must not
  be committed — see [Regenerating with Docker](#regenerating-with-docker).

| Language   | Local plugin (`local.buf.gen.yaml`)                                              | Remote plugin (`remote.buf.gen.yaml`)                                                 | Runtime deps a consumer needs                                                              |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| TypeScript | `protoc-gen-es` 1.10.1, `protoc-gen-connect-es` 1.7.0 (npm, see `package.json`)  | `buf.build/bufbuild/es:v1.10.0`, `buf.build/connectrpc/es:v1.6.1` — pinned, see below | `@bufbuild/protobuf@^1`                                                                    |
| Python     | `protoc --python_out=`/`--pyi_out=` (built into `protoc`) + `grpc_python_plugin` | `buf.build/protocolbuffers/{python,pyi}`, `buf.build/grpc/python`                     | `grpcio`, `protobuf`                                                                       |
| Rust       | `protoc-gen-prost` 0.5.0, `protoc-gen-tonic` 0.5.0 (cargo)                       | `buf.build/community/neoeinstein-{prost,tonic}`                                       | `prost@^0.14`, `tonic@^0.14`, `tonic-prost@^0.14` (must all be the same major — see below) |
| Go         | `protoc-gen-go` v1.36.12, `protoc-gen-go-grpc` v1.6.2 (go install)               | `buf.build/protocolbuffers/go`, `buf.build/grpc/go`                                   | `google.golang.org/protobuf`, `google.golang.org/grpc`                                     |

Local vs. remote produce byte-identical output for Python and Go, and
identical-modulo-generator-version-banner output for TypeScript and Rust: Rust
differs only in attribute-macro whitespace (the local `protoc-gen-prost`/
`protoc-gen-tonic` version formats `#[prost(tag = "1")]` where BSR's older build
emits `#[prost(tag="1")]`); TypeScript differs only in the
`// @generated
by protoc-gen-es vX.Y.Z` comment (`v1.10.1`/`v1.7.0` locally vs
BSR's `v1.10.0`/`v1.6.1` — see below for why those don't match exactly). None of
it is semantic.

### Local plugin install

```sh
# TypeScript — pinned in package.json, installed via npm (see Regenerating)

# Python — protoc's built-in python/pyi generators + the grpc project's own
# protoc-gen-grpc_python plugin (invoked here as `grpc_python_plugin`)
brew install protobuf grpc

# Rust — same neoeinstein/protoc-gen-prost source BSR's community/
# neoeinstein-{prost,tonic} remote plugins wrap; pin the version pair whose
# prost-build/tonic-build dependency matches gen/rust/Cargo.toml (^0.14)
cargo install protoc-gen-prost@0.5.0 protoc-gen-tonic@0.5.0

# Go — pinned to match the versions recorded in gen/go/'s generated file
# headers (`// protoc-gen-go v1.36.12` / `// protoc-gen-go-grpc v1.6.2`)
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2
```

Each installs to its toolchain's normal global bin directory
(`$GOBIN`/`$(go
env GOPATH)/bin`, `~/.cargo/bin`, Homebrew's `bin`) — same
convention as `buf` itself: a developer-machine tool install, not a project
dependency pinned in a lockfile.

### Regenerating with Docker

Skips all of the above — no Go/Rust/`protoc`/`grpc` installs on the host, no
`PATH` wrangling:

```sh
cd packages/fsm-proto-codegen
npm run generate:local:docker
```

Builds the image from this package's `Dockerfile` (multi-stage: `go install`s
Go's plugins, `cargo install`s Rust's, downloads `protoc`'s exact release
binary, apt-installs `grpc_python_plugin`) and runs
`npm install && npm run
generate:local` inside a container with this directory
bind-mounted, so output lands directly in `gen/` like a normal local run.

This is the canonical generator: the committed `gen/` is byte-identical to its
output, and CI's `proto-codegen` workflow enforces that on every PR touching
this package.

Output matches `local.buf.gen.yaml`'s native-host output exactly for TypeScript,
Rust, and Python's message/`.pyi` files (`protoc` is pinned to the identical
`v35.1` release via GitHub, not `apt`'s much older bookworm build). The one
exception: `*_pb2_grpc.py`, from `grpc_python_plugin`. The grpc project
publishes no prebuilt plugin binaries at all (only source), so pinning it
exactly would mean building the whole grpc C++ project from source in the image
— disproportionate for one binary. The image uses Debian's bundled version,
which produces valid but older-style output (`class Foo(object):`, no
`_registered_method=True` — confirmed by actually importing, instantiating, and
subclassing it, not just diffing). That older style is what's committed, so a
host `npm run generate:local` with Homebrew's newer `grpc` rewrites every
`*_pb2_grpc.py` and fails CI's drift check. Discard that part of a host run:

```sh
git checkout -- 'gen/python/**/*_pb2_grpc.py'
```

The container runs `npm install` into the bind-mounted `node_modules/`, which
leaves Linux `buf`/`protoc-gen-*` binaries behind. Before running any `npm run`
script on the host again (macOS/Windows), reinstall:
`rm -rf node_modules && npm ci`.

### TypeScript: local is preferred, but remote is pinned to match

`remote.buf.gen.yaml` pins both TS plugins explicitly
(`buf.build/bufbuild/es:v1.10.0`, `buf.build/connectrpc/es:v1.6.1`) instead of
leaving them unversioned, because leaving either unpinned breaks it outright.

BSR's `connectrpc/es` plugin (the connect-es codegen; also tried historically
under `buf.build/bufbuild/connect-es`) has never published past `v1.6.1` — still
protobuf-es v1's output shape. `remote:` with no version pinned resolves
"latest," and `bufbuild/es`'s latest is `v2.13.0`. Pairing that mismatched pair
produces a `_connect.js` that imports message names (`Empty`, `InvokeRequest`,
...) as values — but the v2 message file only exports them as **types**
(`*Schema` consts carry the runtime value instead). TypeScript hides this, since
type-only imports get erased at compile time, but running the generated JS
directly (Deno, Node) throws
`SyntaxError: ... does not provide an export
named 'Empty'`. Caught by actually
running the generated output, not just type-checking it. (Bumping
`@bufbuild/protobuf` — the runtime dependency, `gen/typescript/deno.json`'s
`imports` / `package.json`'s `devDependencies` — up to v2 doesn't fix this
either; it only trades one resolve error for this one, since the mismatch is
between the two BSR _plugins_, not the runtime.)

Pinning `bufbuild/es` down to `v1.10.0` — BSR's newest available release still
on v1's shape (`v1.10.1`, the exact version `local.buf.gen.yaml` uses via npm,
was never published to BSR) — keeps both plugins on the same shape and produces
output that actually runs, functionally identical to `local.buf.gen.yaml`'s.
`protoc-gen-es`/`protoc-gen-connect-es` still haven't published a matching v2
pair to _any_ registry, so this is the ceiling for what BSR can produce, not a
stopgap on the way to something better.

Still prefer `local.buf.gen.yaml` for regular use: pinning to `package.json`'s
`v1.10.1`/`v1.7.0` guarantees exactly the versions this repo is tested against,
where the BSR pins above are constrained to whatever versions BSR happens to
have last published under those tags (already one patch version behind on both).

### Rust: prost/tonic/tonic-prost must share a major version

`tonic` 0.14 moved its prost-backed codec into a separate `tonic-prost` crate; a
consumer's `Cargo.toml` needs `prost`, `tonic`, and `tonic-prost` all on `^0.14`
(or all on some other later matching triple) — mixing e.g. `prost 0.13` with
`tonic-prost 0.14` fails to compile with a "two different versions of crate
`prost`" trait-mismatch error, since `tonic-prost` pulls its own transitive
`prost`. Consuming code should also only
`include!("pgfsm.activitygateway.v1.rs")` (or `pgfsm.sidecargateway.v1.rs`) for
a language's package module — the generated message file already contains its
own `include!("pgfsm.activitygateway.v1.tonic.rs")` at the bottom, so including
both files separately double-defines the client/server modules.

### Go: `module=` output option

Both files' Go plugins pass `opt: module=.../gen/go` instead of the more common
`paths=source_relative`. With `source_relative`, output mirrors each `.proto`
file's own path relative to the module root — for
`pgfsm/activitygateway/v1/activity_gateway.proto`, that would land at
`gen/go/pgfsm/activitygateway/v1/`, carrying the `pgfsm/` segment from the proto
package's directory structure into the Go import path even though neither
`go_package` option asks for it. `module=` instead derives the output path from
each file's own `go_package` option relative to that module prefix, landing
Activity Gateway's stubs at `gen/go/activitygateway/v1/` and the sidecar's at
`gen/go/sidecargateway/v1/` — idiomatic Go layout, one directory per Go package,
independent of how the `.proto` files themselves are nested.

## Verifying a regen

CI's [`proto-codegen` workflow](../../.github/workflows/proto-codegen.yml) runs
on every PR (and `main` push) that touches this package:

- **`buf lint`** on each `proto/<service>/` module, against its own `buf.yaml`.
- **`buf breaking`** on each module against the PR's base commit (modules new
  since the base are skipped).
- **Drift check**: regenerate with the `Dockerfile` image (layers cached in the
  GitHub Actions cache) and fail if `gen/` has any change, including new
  untracked files.
- **Build/smoke test per language**, so each language's stubs actually build and
  run, not just parse. Run the same checks locally from the repo root:

  ```sh
  # Go
  (cd packages/fsm-proto-codegen/gen/go && go build ./... && go vet ./...)
  # Rust — prost/tonic/tonic-prost ^0.14
  (cd packages/fsm-proto-codegen/gen/rust && cargo build)
  # Python — in a venv; imports the installed package, not the checkout
  pip install ./packages/fsm-proto-codegen/gen/python
  python packages/fsm-proto-codegen/test/smoke_test.py
  # TypeScript — type-checks against the generated .d.ts, then runs
  deno check packages/fsm-proto-codegen/test/smoke.ts
  deno run --allow-env=BUF_BIGINT_DISABLE packages/fsm-proto-codegen/test/smoke.ts
  ```

  The smoke tests round-trip a message through the wire format, and read each
  service descriptor (TypeScript) or subclass each servicer (Python). CI also
  checks each package as it would be published: `cargo publish --dry-run`,
  Python's built wheel (`twine check --strict`, then the smoke test against the
  installed wheel), `deno pack --dry-run`, and
  `scripts/check-release-manifests.ts` (see [Publishing](#publishing)).

## Publishing

All four languages release together, at one version, from one tag, in one run of
[`proto-publish.yml`](../../.github/workflows/proto-publish.yml). Only a
`proto-v*` tag starts it, and every publish job waits on the same manifest
check, so one registry can't be released without the others:

| Language   | Registry  | Package                                                  | Job                                                         |
| ---------- | --------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| TypeScript | npm       | `@pgfsm/proto-codegen`                                   | `npm`: `deno pack`, then `npm publish` (`NPM_TOKEN`)        |
| Python     | PyPI      | `pgfsm-proto-codegen`                                    | `pypi`: trusted publishing                                  |
| Rust       | crates.io | `pgfsm-proto-codegen`                                    | `crates`: `cargo publish` (`CARGO_REGISTRY_TOKEN`)          |
| Go         | git tag   | `github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go` | `go`: pushes tag `packages/fsm-proto-codegen/gen/go/vX.Y.Z` |

The npm package isn't in `npm-publish.yml` with the repo's other npm packages.
That workflow can also be run by hand for one package, which would release npm
out of step with the other three registries.

Go has no registry upload. A Go module in a repo subdirectory is released by a
tag prefixed with that subdirectory, and the Go module proxy serves it from
there — which is also why `gen/go` has to stay committed.

### Cutting a release

1. In a PR, bump `version` in `gen/typescript/deno.json`,
   `gen/python/pyproject.toml` and `gen/rust/Cargo.toml` to the same value (e.g.
   `0.2.0`, or a prerelease like `0.2.0-alpha.0`, which publishes under npm's
   `alpha` dist-tag). CI's `Release manifests agree` step fails if they differ.
2. After it merges, tag the merge commit and push the tag:

   ```sh
   git tag proto-v0.2.0 <merge-commit>
   git push origin proto-v0.2.0
   ```

   This starts `proto-publish.yml`. Its `verify` job runs
   `scripts/check-release-manifests.ts` with the tag's version, and nothing
   publishes if a manifest disagrees.

Re-running a partly failed release is safe: each job skips what's already
published (the npm or crates.io version, the PyPI files, or a Go tag that
already points at the same commit).

### `pyproject.toml`'s protobuf lower bound

Every generated `_pb2.py` calls `ValidateProtobufRuntimeVersion` at import time,
and raises `VersionError` on a protobuf runtime older than the `protoc` that
generated it (`# Protobuf Python Version: X.Y.Z` in each file's header). pip
wouldn't catch that: it would install an older protobuf that satisfies the
range, and the import would fail later. So `protobuf>=` in `pyproject.toml` must
equal that header version. `scripts/check-release-manifests.ts` fails CI if they
differ, e.g. after a `protoc` bump in the `Dockerfile`.

### One-time registry setup

Needed once, before the first release:

- **npm**: nothing new. `@pgfsm/proto-codegen` publishes under the existing
  `@pgfsm` scope with the same `NPM_TOKEN` secret as the other packages.
- **PyPI**: add a
  [pending trusted publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
  for project `pgfsm-proto-codegen`: owner `pgfsm`, repository `fsm`, workflow
  `proto-publish.yml`, environment `pypi`. Create a `pypi` environment in the
  repo's settings; it can require a reviewer approval before each upload.
- **crates.io**: create an API token with the `publish-new` and `publish-update`
  scopes, and save it as the repository secret `CARGO_REGISTRY_TOKEN`. After the
  first publish, the crate can switch to crates.io trusted publishing and drop
  the token.
- **Go**: nothing. The workflow pushes the tag with the job's `GITHUB_TOKEN`,
  and the repository's rulesets only cover branches.
