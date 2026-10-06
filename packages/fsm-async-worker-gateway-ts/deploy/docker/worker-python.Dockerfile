# syntax=docker/dockerfile:1
#
# Python async worker image. Build context: a generated async-worker/python/
# directory (from @pgfsm/cli or @pgfsm/compiler):
#
#   docker build -f <this file> -t my/worker-python async-worker/python
#
# Dependencies go into a virtualenv with uv (pyproject.toml; uv.lock if the
# project has one), and the worker runs as a non-root user. Configure it with
# PGFSM_* environment variables or flags after `start`.

ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.10.12

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM python:${PYTHON_VERSION}-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY . .
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
RUN uv sync --no-dev $( [ -f uv.lock ] && echo --frozen ) \
 && .venv/bin/python run_async_worker.py list

FROM python:${PYTHON_VERSION}-slim
WORKDIR /app
COPY --from=build /app /app
# No __pycache__ writes, so the root filesystem can be read-only.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65532:65532
ENTRYPOINT ["/app/.venv/bin/python", "/app/run_async_worker.py"]
CMD ["start"]
