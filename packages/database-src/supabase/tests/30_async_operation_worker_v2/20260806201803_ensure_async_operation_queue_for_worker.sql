-- ensure_async_operation_queue_for_worker_v2 and compute_async_operation_queue_name_v2
-- (#565). The Activity Gateway calls ensure_… every time an actor registers
-- (gatewayServer.ts), so the queue it creates must be the one the claim and
-- archive paths name with compute_….
begin;
select plan(16);

-- Runs q as role r; returns 'ok' or the SQLSTATE it failed with.
create function pg_temp.sqlstate_as(r text, q text) returns text
language plpgsql as $$
declare
  st text := 'ok';
begin
  begin
    perform set_config('role', r, true);
    execute q;
  exception when others then
    st := sqlstate;
  end;
  reset role;
  return st;
end;
$$;

-- ── Structure ───────────────────────────────────────────────────────────────
select has_function('fsm_core', 'compute_async_operation_queue_name_v2',
  ARRAY['text', 'text', 'text', 'text', 'text', 'text'],
  'compute_async_operation_queue_name_v2(text × 6) exists');
select has_function('fsm_core', 'ensure_async_operation_queue_for_worker_v2',
  ARRAY['text', 'text', 'text', 'text', 'text', 'text'],
  'ensure_async_operation_queue_for_worker_v2(text × 6) exists');
select function_returns('fsm_core', 'ensure_async_operation_queue_for_worker_v2',
  ARRAY['text', 'text', 'text', 'text', 'text', 'text'], 'jsonb',
  'ensure_async_operation_queue_for_worker_v2 returns jsonb');

-- ── Queue naming ────────────────────────────────────────────────────────────
select is(
  fsm_core.compute_async_operation_queue_name_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v07', 'typescript'),
  'pg565Parent_v01_i_doWork_t',
  'internalAsyncOperation: full parent name, type and language shortened to one letter, version dropped'
);
select is(
  fsm_core.compute_async_operation_queue_name_v2(
    'sharedAsyncOperation', 'v01', 'sharedAsyncOperation', 'doWork', 'v01', 'python'),
  's_v01_s_doWork_python',
  'sharedAsyncOperation: parent name and type shortened to one letter, full language, version dropped'
);
select is(
  fsm_core.compute_async_operation_queue_name_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v99', 'typescript'),
  fsm_core.compute_async_operation_queue_name_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v07', 'typescript'),
  'the async operation''s own version has no bearing on the queue name'
);
select isnt(
  fsm_core.compute_async_operation_queue_name_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v01', 'typescript'),
  fsm_core.compute_async_operation_queue_name_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v01', 'python'),
  'workers of different languages serving the same actor get different queues'
);
select throws_ok(
  $$ select fsm_core.compute_async_operation_queue_name_v2(
       'pg565Parent', 'v01', 'fsm', 'doWork', 'v01', 'typescript') $$,
  'P0001',
  'compute_async_operation_queue_name_v2: unsupported input_async_operation_type: fsm',
  'an async_operation_type other than the two async-operation identities raises'
);

-- ── Ensuring the queue ──────────────────────────────────────────────────────
select is(
  fsm_core.ensure_async_operation_queue_for_worker_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v01', 'typescript'),
  '{"queue_name": "pg565Parent_v01_i_doWork_t", "already_existed": false}'::jsonb,
  'first call creates the queue and reports already_existed = false'
);
select is(
  (select count(*)::int from pgmq.meta where queue_name = 'pg565Parent_v01_i_doWork_t'),
  1,
  'the created queue is registered in pgmq.meta under the computed name'
);
select is(
  fsm_core.ensure_async_operation_queue_for_worker_v2(
    'pg565Parent', 'v01', 'internalAsyncOperation', 'doWork', 'v02', 'typescript'),
  '{"queue_name": "pg565Parent_v01_i_doWork_t", "already_existed": true}'::jsonb,
  'a second call for the same actor (any async operation version) reports already_existed = true'
);
select is(
  (select count(*)::int from pgmq.meta where queue_name = 'pg565Parent_v01_i_doWork_t'),
  1,
  'the second call creates no second queue'
);
select throws_ok(
  $$ select fsm_core.ensure_async_operation_queue_for_worker_v2(
       'pg565Parent', 'v01', 'sharedFsm', 'doWork', 'v01', 'typescript') $$,
  'P0001',
  null,
  'an unsupported async_operation_type raises instead of creating a queue'
);

-- ── Access ──────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('fsm_worker',
    'fsm_core.ensure_async_operation_queue_for_worker_v2(text, text, text, text, text, text)', 'execute')
    and has_function_privilege('fsm_worker',
      'fsm_core.compute_async_operation_queue_name_v2(text, text, text, text, text, text)', 'execute')
    and not has_function_privilege('public',
      'fsm_core.ensure_async_operation_queue_for_worker_v2(text, text, text, text, text, text)', 'execute'),
  'fsm_worker may call both functions; PUBLIC may not call ensure_async_operation_queue_for_worker_v2'
);
-- SECURITY DEFINER: the gateway's role creates the queue without owning pgmq.
select is(
  pg_temp.sqlstate_as('fsm_worker', $$ select fsm_core.ensure_async_operation_queue_for_worker_v2(
    'sharedAsyncOperation', 'v01', 'sharedAsyncOperation', 'pg565Shared', 'v01', 'go') $$),
  'ok',
  'fsm_worker can create a queue through it'
);
select is(
  pg_temp.sqlstate_as('fsm_operator', $$ select fsm_core.ensure_async_operation_queue_for_worker_v2(
    'sharedAsyncOperation', 'v01', 'sharedAsyncOperation', 'pg565Shared', 'v01', 'go') $$),
  '42501',
  'fsm_operator cannot call it'
);

select * from finish();
rollback;
