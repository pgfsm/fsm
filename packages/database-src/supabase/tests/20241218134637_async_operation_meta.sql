begin;
select plan(18);

-- Tier 1: structural
select has_table('fsm_core', 'async_operation_meta', 'fsm_core.async_operation_meta exists');
select col_is_pk('fsm_core', 'async_operation_meta', 'async_operation_meta_id', 'async_operation_meta_id is the primary key');
select has_column('fsm_core', 'async_operation_meta', 'async_operation_name', 'has async_operation_name column');
select has_column('fsm_core', 'async_operation_meta', 'async_operation_type', 'has async_operation_type column');
select has_column('fsm_core', 'async_operation_meta', 'async_operation_version', 'has async_operation_version column');
select has_column('fsm_core', 'async_operation_meta', 'parent_fsm_name', 'has parent_fsm_name column');
select has_column('fsm_core', 'async_operation_meta', 'parent_fsm_version', 'has parent_fsm_version column');
select has_column('fsm_core', 'async_operation_meta', 'max_concurrency', 'has max_concurrency column');
select has_column('fsm_core', 'async_operation_meta', 'async_operation_language', 'has async_operation_language column');
select has_column('fsm_core', 'async_operation_meta', 'updated_at', 'has updated_at column');
select has_column('fsm_core', 'async_operation_meta', 'updated_by_pid', 'has updated_by_pid column');
select col_is_unique('fsm_core', 'async_operation_meta',
  ARRAY['async_operation_name', 'async_operation_version', 'async_operation_type', 'parent_fsm_name', 'parent_fsm_version'],
  'unique constraint covers the five identifying columns');
select has_function('fsm_core', 'load_async_operation_meta_v2',
  ARRAY['text', 'text', 'text', 'text', 'text', 'text', 'text'],
  'fsm_core.load_async_operation_meta_v2(7 x text) exists');

-- Tier 2: behavioral — insert-or-update (upsert) semantics
select lives_ok(
  $$ select fsm_core.load_async_operation_meta_v2(
       'opA', '1', 'internalAsync', 'python', 'fsmA', '1', 'pid-1') $$,
  'first load_async_operation_meta_v2 call inserts cleanly'
);
select results_eq(
  $$ select (fsm_core.load_async_operation_meta_v2(
       'opA', '1', 'internalAsync', 'python', 'fsmA', '1', 'pid-2') ->> 'updated_by_pid') $$,
  $$ values ('pid-2'::text) $$,
  'second call with the same unique key upserts updated_by_pid'
);
select results_eq(
  $$ select count(*) from fsm_core.async_operation_meta
     where async_operation_name = 'opA' and async_operation_version = '1'
       and async_operation_type = 'internalAsync' and parent_fsm_name = 'fsmA'
       and parent_fsm_version = '1' $$,
  $$ values (1::bigint) $$,
  'upsert on the same unique key never duplicates the row'
);
select results_eq(
  $$ select async_operation_language from fsm_core.async_operation_meta
     where async_operation_name = 'opA' and async_operation_version = '1'
       and async_operation_type = 'internalAsync' and parent_fsm_name = 'fsmA'
       and parent_fsm_version = '1' $$,
  $$ values ('python'::text) $$,
  'original async_operation_language is retained across the upsert'
);
select results_eq(
  $$ select max_concurrency from fsm_core.async_operation_meta
     where async_operation_name = 'opA' and async_operation_version = '1'
       and async_operation_type = 'internalAsync' and parent_fsm_name = 'fsmA'
       and parent_fsm_version = '1' $$,
  $$ values (8) $$,
  'max_concurrency defaults to 8'
);

select * from finish();
rollback;
