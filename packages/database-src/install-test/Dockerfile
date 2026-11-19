# Stock Postgres with fsm_core's two server-side prerequisites, pg_cron and
# pgmq (SPEC-016, #688): CI's install job, and locally (see
# ../README.md, "Building and testing the install").
#
#   docker build --build-arg PG_MAJOR=16 -t pgfsm-install-test:16 .
#
# pg_cron comes from PGDG. PGDG doesn't package pgmq, so it comes from its
# source release. It's SQL-only: its Makefile's install is a copy of
# pgmq.control and sql/*--*.sql (with sql/pgmq.sql as pgmq--<version>.sql)
# into the extension directory, done here with plain cp so no build tools or
# server headers are needed. ltree ships with Postgres.
ARG PG_MAJOR=16

FROM postgres:${PG_MAJOR} AS pgmq
ARG PG_MAJOR
# The version Supabase runs, and the one the PGXN bundle's META.json requires.
ARG PGMQ_VERSION=1.4.4
ADD https://github.com/pgmq/pgmq/archive/refs/tags/v${PGMQ_VERSION}.tar.gz /tmp/pgmq.tar.gz
RUN set -eux; \
  src="/tmp/pgmq-${PGMQ_VERSION}/pgmq-extension"; \
  tar xzf /tmp/pgmq.tar.gz -C /tmp; \
  grep -q "^default_version = '${PGMQ_VERSION}'" "$src/pgmq.control"; \
  mkdir -p /out; \
  cp "$src/pgmq.control" "$src"/sql/*--*.sql /out/; \
  cp "$src/sql/pgmq.sql" "/out/pgmq--${PGMQ_VERSION}.sql"

FROM postgres:${PG_MAJOR}
ARG PG_MAJOR
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-cron \
  && rm -rf /var/lib/apt/lists/*
COPY --from=pgmq /out/ /usr/share/postgresql/${PG_MAJOR}/extension/
CMD ["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=postgres"]
