# CLAUDE.md — Proto Codegen (`packages/fsm-proto-codegen/`)

Scoped guidance for `@pgfsm/proto-codegen-plugins`. Repo-wide conventions and
session protocol live in the root `CLAUDE.md` / `AGENTS.md`. Full docs (why this
exists, the plugin table, per-language gotchas) are in this package's
`README.md` — read it before touching `local.buf.gen.yaml` /
`remote.buf.gen.yaml` / `hybrid.buf.gen.yaml` or regenerating.

## Commands

```bash
cd packages/fsm-proto-codegen
npm install                          # once, or after a plugin version bump
npm run generate:local:docker        # local.buf.gen.yaml, containerized -- canonical, what CI checks gen/ against
npm run generate:local               # buf generate --template local.buf.gen.yaml on the host (gen/python caveat)
npm run generate:remote              # buf generate --template remote.buf.gen.yaml (works, but prefer local)
npm run generate:hybrid              # buf generate --template hybrid.buf.gen.yaml (TS local + rest remote)
```

Commit exactly what `generate:local:docker` produces, in the same PR as the
`.proto` change. `.github/workflows/proto-codegen.yml` runs `buf lint`,
`buf breaking` (against the PR base), a regenerate-and-diff drift check on
`gen/`, and a build/smoke test per language (`test/smoke.ts`,
`test/smoke_test.py`, `go build`, `cargo build`) — see README's "Verifying a
regen" to run them locally.

`buf` itself and TypeScript's two `protoc-gen-*` plugins come from
`node_modules/.bin` via `npm install` — no separate `buf` CLI install needed.
`generate:local` additionally needs `protoc`, `grpc_python_plugin`,
`protoc-gen-go`, `protoc-gen-go-grpc`, `protoc-gen-prost`, `protoc-gen-tonic` on
`PATH` (not npm-managed) — see README's "Local plugin install".
`generate:local:docker` needs none of that on the host, just Docker. A host
`generate:local` rewrites every `*_pb2_grpc.py` in Homebrew's newer
`grpc_python_plugin` style, which fails CI's drift check — discard those files
(README's "Regenerating with Docker"). After a Docker run, `node_modules/` holds
Linux binaries: `rm -rf node_modules && npm ci` before the next host run.

## What it does

Owns both the `.proto` contract sources (one directory per defining service
under `proto/<service>/`, each its own independent Buf module — see README's
Layout section) and the codegen config that runs every one of them through Buf's
plugin pipeline to produce stubs for all four polyglot actor languages
(TypeScript, Python, Rust, Go), committed under `gen/`. Today that's
`proto/fsm-core-async-op-worker/` — the Activity Gateway's client-facing
`activity_gateway.proto` and worker-facing `sidecar_gateway.proto`.

`package.json` / `node_modules/` here are not app dependencies — just the
`protoc-gen-es` / `protoc-gen-connect-es` binaries `buf generate` needs on
`PATH` for TypeScript output. Nothing in this package is imported by app code.
