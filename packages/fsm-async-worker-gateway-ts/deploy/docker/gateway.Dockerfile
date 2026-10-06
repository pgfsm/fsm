# syntax=docker/dockerfile:1
#
# Activity Gateway image (SPEC-007), built from this repository's source.
#
#   docker build -f packages/fsm-async-worker-gateway-ts/deploy/docker/gateway.Dockerfile \
#     --build-arg DENO_VERSION=$(sed -n 's/^deno = "\(.*\)"/\1/p' .prototools) \
#     -t pgfsm/async-worker-gateway:dev .
#
# The build context is the repository root, but only the packages the gateway
# imports are copied in (@pgfsm/db, @pgfsm/logging, @pgfsm/proto-codegen's
# TypeScript stubs), under a workspace listing just those. `deno compile`
# embeds the npm packages of every workspace member's package.json, so the
# full workspace would pull in Supabase's and buf's CLI binaries (~576 MB of
# embedded files instead of ~30 MB). Both CLIs are compiled into
# self-contained binaries and run as non-root on a distroless base, so the
# pod passes Pod Security "restricted" with a read-only root filesystem
# (mount an emptyDir at /tmp for its Unix sockets).
#
# --node-modules-dir=none: resolve npm packages from Deno's global cache
# instead of installing node_modules next to them.
# --no-check: without node_modules `pg`'s types don't resolve; type checking
# is CI's job (`deno check`).

ARG DENO_VERSION=2.9.4

FROM denoland/deno:${DENO_VERSION} AS build
# The release version (gateway-release.yml sets it); the binary must report it.
ARG VERSION=
WORKDIR /src
COPY packages/fsm-logging-ts packages/fsm-logging-ts
COPY packages/fsm-core-db-ts packages/fsm-core-db-ts
COPY packages/fsm-async-worker-gateway-ts packages/fsm-async-worker-gateway-ts
COPY packages/fsm-proto-codegen/gen/typescript packages/fsm-proto-codegen/gen/typescript
# Type-only import of @pgfsm/db's generated database types.
COPY packages/database-src/generated packages/database-src/generated
RUN set -eux; \
    printf '%s\n' '{ "workspace": [' \
      '"packages/fsm-logging-ts", "packages/fsm-core-db-ts",' \
      '"packages/fsm-async-worker-gateway-ts", "packages/fsm-proto-codegen/gen/typescript"' \
      '] }' > deno.json; \
    cli=packages/fsm-async-worker-gateway-ts/src/cli; \
    for bin in async-operation-worker-gateway async-operation-worker-gateway-ctl; do \
      deno compile --no-check --node-modules-dir=none --allow-all \
        --include packages/fsm-async-worker-gateway-ts/deno.json \
        --output /out/$bin $cli/$bin.ts; \
    done; \
    reported=$(/out/async-operation-worker-gateway --version); \
    echo "$reported"; \
    if [ -n "$VERSION" ]; then \
      case "$reported" in *"$VERSION"*) ;; *) echo "expected version $VERSION" >&2; exit 1 ;; esac; \
    fi

FROM gcr.io/distroless/cc-debian12:nonroot
ARG VERSION=dev
LABEL org.opencontainers.image.title="pgfsm Activity Gateway" \
      org.opencontainers.image.description="pgfsm Activity Gateway (async-operation worker gateway)" \
      org.opencontainers.image.source="https://github.com/pgfsm/fsm" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build /out/ /usr/local/bin/
USER nonroot
# Sidecar listener for TCP workers (--sidecar-listen tcp://0.0.0.0:7443).
EXPOSE 7443
ENTRYPOINT ["/usr/local/bin/async-operation-worker-gateway"]
