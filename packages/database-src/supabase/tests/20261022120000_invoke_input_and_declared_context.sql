-- SPEC-013 (#584): the FSM JSON schema accepts an invoke's static `input` or
-- its `inputName` (not both), and an instance starts from its definition's
-- static context shallow-merged with the context it's created with.
begin;
select plan(11);

-- A definition with a static context and two invokes: one with a static input,
-- one with an input stub's name.
select lives_ok(
  $$ select fsm_core.load_fsm_from_json_v2(
       '{"id":"spec013","key":"spec013","type":"compound","order":-1,
         "context":{"tries":0,"mode":"declared"},
         "states":{
           "red":{"id":"spec013.red","key":"red","type":"atomic","order":1,
             "invoke":[{"type":"xstate.invoke","id":"staticInvoke","src":"checkBureau",
                        "asyncOperationType":"internalAsyncOperation","asyncOperationVersion":"v1",
                        "input":{"bureauName":"EquiGavin"}}],
             "transitions":[{"source":"#spec013.red","target":["#spec013.green"],"eventType":"NEXT","actions":[]}]},
           "green":{"id":"spec013.green","key":"green","type":"atomic","order":2,
             "invoke":[{"type":"xstate.invoke","id":"mappedInvoke","src":"checkBureau",
                        "asyncOperationType":"internalAsyncOperation","asyncOperationVersion":"v1",
                        "inputName":"mappedInvoke"}],
             "transitions":[{"source":"#spec013.green","target":["#spec013.red"],"eventType":"NEXT","actions":[]}]}
         }}'::jsonb,
       NULL, 'spec013Fsm', 'v1') $$,
  'a definition with a static context, a static invoke input and an inputName loads'
);

select ok(
  fsm_core.json_matches_schema(fsm_core.fsm_json_schema(),
    '{"id":"s","key":"s","type":"compound","context":{"tries":0},"states":{
       "a":{"id":"s.a","key":"a","type":"atomic","on":{},
         "invoke":[{"type":"xstate.invoke","id":"i","src":"x","asyncOperationType":"internalAsyncOperation",
                    "asyncOperationVersion":"v1","input":{"bureauName":"EquiGavin"}}]},
       "b":{"id":"s.b","key":"b","type":"atomic","on":{},
         "invoke":[{"type":"xstate.invoke","id":"j","src":"x","asyncOperationType":"internalAsyncOperation",
                    "asyncOperationVersion":"v1","inputName":"j"}]}}}'::json),
  'a static object input and an inputName are each valid on an invoke'
);
select ok(
  fsm_core.json_matches_schema(fsm_core.fsm_json_schema(),
    '{"id":"s","key":"s","type":"compound","states":{"a":{"id":"s.a","key":"a","type":"atomic","on":{},
       "invoke":[{"type":"xstate.invoke","id":"i","src":"x","asyncOperationType":"internalAsyncOperation",
                  "asyncOperationVersion":"v1","input":"EquiGavin"}]}}}'::json),
  'a string static input is valid (a value, not a reference)'
);
select ok(
  not fsm_core.json_matches_schema(fsm_core.fsm_json_schema(),
    '{"id":"s","key":"s","type":"compound","states":{"a":{"id":"s.a","key":"a","type":"atomic","on":{},
       "invoke":[{"type":"xstate.invoke","id":"i","src":"x","asyncOperationType":"internalAsyncOperation",
                  "asyncOperationVersion":"v1","input":{"a":1},"inputName":"i"}]}}}'::json),
  'an invoke with both input and inputName is invalid'
);
select ok(
  not fsm_core.json_matches_schema(fsm_core.fsm_json_schema(),
    '{"id":"s","key":"s","type":"compound","states":{"a":{"id":"s.a","key":"a","type":"atomic","on":{},
       "invoke":[{"type":"xstate.invoke","id":"i","src":"x","asyncOperationType":"internalAsyncOperation",
                  "asyncOperationVersion":"v1","inputName":42}]}}}'::json),
  'a non-string inputName is invalid'
);

-- Instance context: the declared context, merged with the given one (which wins).
select is(
  (fsm_core.create_fsm_instance_from_name_v2('spec013Fsm', 'v1', '{"mode":"given","ssn":"123"}'::jsonb, false))
    ->'fsm_instance_context',
  '{"tries":0,"mode":"given","ssn":"123"}'::jsonb,
  'the given context is shallow-merged over the declared one, and wins'
);
select is(
  (select fsm_instance_context from fsm_core.fsm_instance
    where fsm_name = 'spec013Fsm' and fsm_instance_context ? 'ssn'),
  '{"tries":0,"mode":"given","ssn":"123"}'::jsonb,
  'the merged context is what the instance row stores'
);
select is(
  (fsm_core.create_fsm_instance_from_name_v2('spec013Fsm', 'v1', NULL, false))->'fsm_instance_context',
  '{"tries":0,"mode":"declared"}'::jsonb,
  'with no given context the instance starts from the declared one'
);
select is(
  (fsm_core.create_fsm_instance_from_name_v2('spec013Fsm', 'v1', '["not","an","object"]'::jsonb, false))
    ->'fsm_instance_context',
  '{"tries":0,"mode":"declared"}'::jsonb,
  'a non-object given context is dropped: the instance starts from the declared context alone'
);

-- Without a declared context, the given context is used as before.
select lives_ok(
  $$ select fsm_core.load_fsm_from_json_v2(
       '{"id":"spec013b","key":"spec013b","type":"compound","order":-1,"states":{
          "only":{"id":"spec013b.only","key":"only","type":"atomic","order":1,
            "transitions":[{"source":"#spec013b.only","target":["#spec013b.only"],"eventType":"NEXT","actions":[]}]}
        }}'::jsonb,
       NULL, 'spec013NoContext', 'v1') $$,
  'a definition without a context loads'
);
select is(
  (fsm_core.create_fsm_instance_from_name_v2('spec013NoContext', 'v1', '{"a":1}'::jsonb, false))
    ->'fsm_instance_context',
  '{"a":1}'::jsonb,
  'without a declared context the given context is used unchanged'
);

select * from finish();
rollback;
