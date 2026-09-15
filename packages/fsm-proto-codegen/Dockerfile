# Bakes in every local: plugin binary local.buf.gen.yaml needs, pinned to the
# same versions as README's "Local plugin install" -- an alternative to
# installing Go/Rust/protoc/grpc toolchains on the host, see README's
# "Regenerating with Docker". Not used for remote.buf.gen.yaml or
# hybrid.buf.gen.yaml's Python/Rust/Go entries (those are BSR-resolved, no
# local binary needed) or for anything at runtime -- codegen only.

FROM golang:1.26-bookworm AS go-plugins
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12 && \
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2

FROM rust:1.98-bookworm AS rust-plugins
RUN cargo install protoc-gen-prost@0.5.0 protoc-gen-tonic@0.5.0

FROM node:22-bookworm-slim
ARG TARGETARCH

# protoc, pinned to the exact release Homebrew's `protobuf` formula installs
# on macOS (see README) -- apt's `protobuf-compiler` on bookworm resolves to
# a much older, unpinned release (pre-runtime_version-check codegen shape),
# which would make this image's Python output diverge from what's committed.
# The official GitHub release zip is the only source of an exact pin.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip curl \
    && rm -rf /var/lib/apt/lists/* \
    && PROTOC_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo aarch_64 || echo x86_64) \
    && curl -fsSL -o /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v35.1/protoc-35.1-linux-${PROTOC_ARCH}.zip" \
    && unzip -q /tmp/protoc.zip -d /usr/local bin/protoc \
    && rm /tmp/protoc.zip

# grpc_python_plugin, from Debian's protobuf-compiler-grpc -- NOT pinned to
# Homebrew's grpc 1.83.0: the grpc project publishes no prebuilt plugin
# binaries (its GitHub releases carry source only), so an exact pin here
# means building the whole grpc C++ project from source. Debian bookworm's
# older bundled version produces valid but differently-styled *_pb2_grpc.py
# (old-style `class Foo(object):`, no _registered_method=True) -- confirmed
# functionally correct (import + instantiate + subclass), just not
# byte-identical to gen/python's committed output. See README's
# "Regenerating with Docker".
RUN apt-get update && apt-get install -y --no-install-recommends \
      protobuf-compiler-grpc \
    && rm -rf /var/lib/apt/lists/*

COPY --from=go-plugins /go/bin/protoc-gen-go /go/bin/protoc-gen-go-grpc /usr/local/bin/
COPY --from=rust-plugins /usr/local/cargo/bin/protoc-gen-prost /usr/local/cargo/bin/protoc-gen-tonic /usr/local/bin/

# buf itself and protoc-gen-es/protoc-gen-connect-es come from `npm install`
# (package.json's devDependencies) at container start, not baked in here, so
# a plugin version bump only needs package.json edited -- not an image
# rebuild.
WORKDIR /workspace
CMD ["sh", "-c", "npm install && npm run generate:local"]
