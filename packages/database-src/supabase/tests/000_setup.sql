-- pgTAP bootstrap. Runs first (pg_prove executes files in alphabetical
-- order). Not part of supabase/schemas/ on purpose: pgtap is a test-only
-- dependency, and schemas/ is the declarative prod schema compiled by
-- `supabase db diff`. Idempotent so it self-heals after `supabase db reset`.
--
-- No begin/rollback wrapper here: CREATE EXTENSION must commit so the
-- extension is actually available to every subsequent test file.
create extension if not exists pgtap with schema extensions;

select plan(1);
select pass('pgtap extension bootstrap complete');
select * from finish();
