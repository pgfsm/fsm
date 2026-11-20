-- fsm_core's installed version (SPEC-016). Written by
-- supabase-restart-with-diff.ts (setSchemaVersion) on every new version; do
-- not edit. scripts/check-fsm-core-version.ts checks it's the newest
-- migration's target.

create or replace function fsm_core.version()
returns text
language sql
immutable
as $$
  select '1.2.0'::text
$$;
