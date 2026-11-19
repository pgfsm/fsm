# syntax=docker/dockerfile:1
#
# pgfsm API image (SPEC-016, #689), built from this repository's source.
#
#   docker build -f packages/fsm-api-ts/deploy/docker/api.Dockerfile \
#     --build-arg DENO_VERSION=$(sed -n 's/^deno = "\(.*\)"/\1/p' .prototools) \
#     -t pgfsm/api:dev .
#
# Same shape as the gateway's image: the build context is the repository
# root, but only the packages the API imports are copied in (@pgfsm/db,
# @pgfsm/logging, the generated database types), under a workspace listing
# just those, so `deno compile` doesn't embed every member's npm packages.
# `pgfsm-api` is compiled into a self-contained binary and runs as non-root
# on a distroless base: the pod passes Pod Security "restricted" with a
# read-only root filesystem.
#
# --node-modules-dir=none: resolve npm packages from Deno's global cache.
# --no-check: type checking is CI's job (`deno check`).

ARG DENO_VERSION=2.9.8

FROM denoland/deno:${DENO_VERSION} AS build
# The release version (api-release.yml sets it); the binary must report it.
ARG VERSION=
WORKDIR /src
COPY packages/fsm-logging-ts packages/fsm-logging-ts
COPY packages/fsm-core-db-ts packages/fsm-core-db-ts
COPY packages/fsm-api-ts packages/fsm-api-ts
# Type-only import of @pgfsm/db's generated database types.
COPY packages/database-src/generated packages/database-src/generated
RUN set -eux; \
    printf '%s\n' '{ "workspace": [' \
      '"packages/fsm-logging-ts", "packages/fsm-core-db-ts", "packages/fsm-api-ts"' \
      '] }' > deno.json; \
    deno compile --no-check --node-modules-dir=none --allow-all \
      --include packages/fsm-api-ts/deno.json \
      --output /out/pgfsm-api packages/fsm-api-ts/src/cli/index.ts; \
    reported=$(/out/pgfsm-api --version); \
    echo "$reported"; \
    if [ -n "$VERSION" ]; then \
      case "$reported" in *"$VERSION"*) ;; *) echo "expected version $VERSION" >&2; exit 1 ;; esac; \
    fi

FROM gcr.io/distroless/cc-debian12:nonroot
ARG VERSION=dev
LABEL org.opencontainers.image.title="pgfsm API" \
      org.opencontainers.image.description="pgfsm REST API (pgfsm-api)" \
      org.opencontainers.image.source="https://github.com/pgfsm/fsm" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build /out/ /usr/local/bin/
USER nonroot
# The CLI reads ./.env if present; the image has none, so configuration comes
# from flags and the environment (DATABASE_URL, PGFSM_ENABLE_ADMIN_API, …).
WORKDIR /home/nonroot
EXPOSE 9999
ENTRYPOINT ["/usr/local/bin/pgfsm-api"]
