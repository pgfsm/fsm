-- fsm_core.version() and require_version() (SPEC-016, #688): the database
-- records its version; upgrade scripts start with require_version() so one
-- applied to the wrong version fails before changing anything.
begin;
select plan(8);

select has_function('fsm_core', 'version', ARRAY[]::text[], 'fsm_core.version() exists');
select volatility_is('fsm_core', 'version', ARRAY[]::text[], 'immutable',
  'version() is IMMUTABLE');
select matches(fsm_core.version(), '^\d+\.\d+\.\d+$', 'version() is a semver version');
select ok(
  has_function_privilege('fsm_operator', 'fsm_core.version()', 'execute')
    and has_function_privilege('fsm_worker', 'fsm_core.version()', 'execute')
    and has_function_privilege('fsm_authenticator', 'fsm_core.version()', 'execute'),
  'the API, fsmlet and gateway roles can read it (startup version check)'
);
select ok(
  not has_function_privilege('fsm_operator', 'fsm_core.require_version(text)', 'execute'),
  'require_version() is for the installer only'
);

select lives_ok(
  format('select fsm_core.require_version(%L)', fsm_core.version()),
  'require_version(<the installed version>) passes'
);
select throws_ok(
  'select fsm_core.require_version(''0.0.1'')',
  'P0001',
  format('fsm_core 0.0.1 required, found %s', fsm_core.version()),
  'require_version(<another version>) fails, naming both versions'
);

-- Before 2.3.0 there was no version(): require_version() says so.
alter function fsm_core.version() rename to version_hidden;
select throws_ok(
  'select fsm_core.require_version(''2.2.2'')',
  'P0001',
  'fsm_core 2.2.2 required, found a version before 2.3.0 (no fsm_core.version())',
  'without version(), require_version() reports a version before 2.3.0'
);
alter function fsm_core.version_hidden() rename to version;

select * from finish();
rollback;
