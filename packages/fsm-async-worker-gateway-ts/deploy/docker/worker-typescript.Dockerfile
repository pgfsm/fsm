# syntax=docker/dockerfile:1
#
# TypeScript async worker image. Build context: a generated
# async-worker/typescript/ directory (from @pgfsm/cli or @pgfsm/compiler):
#
#   docker build -f <this file> -t my/worker-typescript async-worker/typescript
#
# run-async-worker.ts is `deno compile`d into one binary and runs as non-root
# on a distroless base. Configure it with PGFSM_* environment variables
# (PGFSM_GATEWAY_ADDRESS, PGFSM_GATEWAY_CA_FILE, PGFSM_GATEWAY_TOKEN_FILE,
# PGFSM_MAX_CONCURRENCY, ...) or flags after `start`.

ARG DENO_VERSION=2.9.4

FROM denoland/deno:${DENO_VERSION} AS build
WORKDIR /src
COPY . .
RUN deno compile --allow-all --output /out/worker run-async-worker.ts \
 && /out/worker list

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/worker /usr/local/bin/worker
USER nonroot
ENTRYPOINT ["/usr/local/bin/worker"]
CMD ["start"]
