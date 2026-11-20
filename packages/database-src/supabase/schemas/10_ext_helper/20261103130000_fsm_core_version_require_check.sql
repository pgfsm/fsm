-- fsm_core.require_version() (SPEC-016, #688). fsm_core.version() is in
-- 20261103120000_fsm_core_version.sql, which supabase-restart-with-diff.ts
-- rewrites for every new version.
--
-- Every upgrade script after the 1.2.0 baseline starts with
--   SELECT fsm_core.require_version('<the version it upgrades from>');
-- so applying one out of order (or twice) fails before changing anything.
-- scripts/check-fsm-core-version.ts enforces it. The API, fsmlet and gateway
-- check fsm_core.version() at startup (@pgfsm/db's requireFsmCoreVersion).

create or replace function fsm_core.require_version(input_expected text)
returns void
language plpgsql
as $$
declare
  found text;
begin
  begin
    found := fsm_core.version();
  exception when undefined_function then
    found := null;
  end;
  if found is distinct from input_expected then
    raise exception 'fsm_core % required, found %', input_expected,
      coalesce(found, 'a version before 2.3.0 (no fsm_core.version())')
      using hint = 'Apply the upgrade scripts in order, starting from the installed version.';
  end if;
end;
$$;
