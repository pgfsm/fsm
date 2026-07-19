begin;
select plan(4);

select has_schema('fsm_core', 'fsm_core schema exists');
select has_extension('pg_jsonschema', 'pg_jsonschema extension is installed');
select has_function('fsm_core', 'hello', ARRAY['text'], 'fsm_core.hello(text) exists');
select lives_ok(
  $$ select fsm_core.hello('world') $$,
  'fsm_core.hello(text) runs without error'
);

select * from finish();
rollback;
