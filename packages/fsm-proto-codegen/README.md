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
  convention as `apps/fsm-core-example/async-worker/`) so consumers don't need
  Buf installed just to build against it. Each carries its own hand-written
  package manifest giving the generated stubs a real package identity for that
  language's toolchain — `gen/typescript/deno.json` (`exports` map + the
  `imports` map generated code needs to resolve `@bufbuild/protobuf` at
  runtime), `gen/rust/Cargo.toml`, `gen/python/pyproject.toml`, `gen/go/go.mod`
  — same convention across all four, see #106.
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

npm run generate:local               # recommended — see below
npm run generate:remote              # BSR only, no local toolchain needed
npm run generate:hybrid              # TS local + Python/Rust/Go remote
npm run generate:local:docker        # local.buf.gen.yaml's plugins, containerized — see below
```

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
  same plugin versions as `local.buf.gen.yaml`, containerized, with one caveat
  (`grpc_python_plugin`'s output) — see
  [Regenerating with Docker](#regenerating-with-docker).
- Full exact version control, every language, no BSR dependency, no Docker
  either? → `local.buf.gen.yaml` on the host — the default recommendation, and
  what's committed under `gen/` today.

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

Output matches `local.buf.gen.yaml`'s native-host output exactly for TypeScript,
Rust, and Python's message/`.pyi` files (`protoc` is pinned to the identical
`v35.1` release via GitHub, not `apt`'s much older bookworm build). The one
exception: `*_pb2_grpc.py`, from `grpc_python_plugin`. The grpc project
publishes no prebuilt plugin binaries at all (only source), so pinning it
exactly would mean building the whole grpc C++ project from source in the image
— disproportionate for one binary. Debian's bundled version produces valid but
differently-styled output (old-style `class Foo(object):`, no
`_registered_method=True` — confirmed by actually importing, instantiating, and
subclassing it, not just diffing), not byte-identical to what's committed.
Discard it if you don't want the diff:

```sh
git checkout -- gen/python/
```

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

Each language was confirmed to actually build/run against `local.buf.gen.yaml`'s
generated output, not just parse:

- **Go**: `go build` in an isolated module requiring
  `google.golang.org/protobuf` + `google.golang.org/grpc`.
- **Python**: `grpcio`/`protobuf` installed, then the `_pb2`/`_pb2_grpc` modules
  imported and a message actually instantiated.
- **Rust**: `cargo build` against `prost`/`tonic`/`tonic-prost` `^0.14`.
- **TypeScript**: run (not just type-checked) under Deno against
  `@bufbuild/protobuf@^1`, instantiating a message and reading the service
  descriptor's `typeName`.
