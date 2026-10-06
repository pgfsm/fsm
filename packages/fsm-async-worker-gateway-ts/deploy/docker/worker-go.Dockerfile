# syntax=docker/dockerfile:1
#
# Go async worker image. Build context: a generated async-worker/go/
# directory (from @pgfsm/cli or @pgfsm/compiler):
#
#   docker build -f <this file> -t my/worker-go async-worker/go
#
# Builds a static binary and runs it as non-root on a distroless base.
# Configure it with PGFSM_* environment variables or flags after `start`.

ARG GO_VERSION=1.26

FROM golang:${GO_VERSION} AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /worker . \
 && /worker list

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /worker /usr/local/bin/worker
USER nonroot
ENTRYPOINT ["/usr/local/bin/worker"]
CMD ["start"]
