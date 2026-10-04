# syntax=docker/dockerfile:1
#
# Rust async worker image. Build context: a generated async-worker/rust/
# directory (from @pgfsm/cli or @pgfsm/compiler):
#
#   docker build -f <this file> -t my/worker-rust async-worker/rust
#
# Builds the release binary and runs it as non-root on a distroless base. The
# builder stays on Debian 12 (bookworm) to match distroless/cc-debian12's glibc.
# Configure it with PGFSM_* environment variables or flags after `start`.

ARG RUST_VERSION=1.95.0

FROM rust:${RUST_VERSION}-slim-bookworm AS build
WORKDIR /src
COPY . .
# `cargo install` puts the project's one binary in /out/bin, whatever it's named.
RUN cargo install --path . --root /out \
 && cp /out/bin/* /worker \
 && /worker list

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /worker /usr/local/bin/worker
USER nonroot
ENTRYPOINT ["/usr/local/bin/worker"]
CMD ["start"]
