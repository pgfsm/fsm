begin;
select plan(35);

-- Tier 1: structural
select has_function('fsm_core', 'path_string_to_jsonb', ARRAY['text'], 'path_string_to_jsonb(text) exists');
select has_function('fsm_core', 'jsonb_deep_merge', ARRAY['jsonb', 'jsonb'], 'jsonb_deep_merge(jsonb, jsonb) exists');
select has_function('fsm_core', 'build_nested_json_recursive', ARRAY['text[]'], 'build_nested_json_recursive(text[]) exists');
select has_function('fsm_core', 'jsonb_all_paths', ARRAY['jsonb', 'text'], 'jsonb_all_paths(jsonb, text) exists');
select has_function('fsm_core', 'test_jsonb_roundtrip', ARRAY['jsonb'], 'test_jsonb_roundtrip(jsonb) exists');

-- Tier 2: fsm_core.path_string_to_jsonb
select results_eq(
  $$ select fsm_core.path_string_to_jsonb('machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin') $$,
  $$ values ('{"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": "CheckingEquiGavin"}}}}'::jsonb) $$,
  'path_string_to_jsonb builds nested objects from a dotted path'
);
select results_eq(
  $$ select fsm_core.path_string_to_jsonb('') $$,
  $$ values ('{}'::jsonb) $$,
  'path_string_to_jsonb('''') returns an empty object'
);
select results_eq(
  $$ select fsm_core.path_string_to_jsonb(NULL) $$,
  $$ values ('{}'::jsonb) $$,
  'path_string_to_jsonb(NULL) returns an empty object'
);
select results_eq(
  $$ select fsm_core.path_string_to_jsonb('root') $$,
  $$ values ('{"root": null}'::jsonb) $$,
  'a single-segment path becomes {"segment": null}'
);

-- Tier 2: fsm_core.jsonb_deep_merge
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{"a": "value1"}'::jsonb, '{"a": "value2"}'::jsonb) $$,
  $$ values ('{"a": "value2"}'::jsonb) $$,
  'overlapping scalar keys: b wins'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{"a": {"b": "value1"}}'::jsonb, '{"a": {"c": "value2"}}'::jsonb) $$,
  $$ values ('{"a": {"b": "value1", "c": "value2"}}'::jsonb) $$,
  'nested objects with different keys are merged, not replaced'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{"a": {"b": "value1"}}'::jsonb, '{"a": "value2", "c": {"d": "value3"}}'::jsonb) $$,
  $$ values ('{"a": {"b": "value1", "value2": null}, "c": {"d": "value3"}}'::jsonb) $$,
  'merging an object with a scalar folds the scalar in as a null-valued key'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{"a": "value2"}'::jsonb, NULL) $$,
  $$ values ('{"a": "value2"}'::jsonb) $$,
  'merging with NULL b returns a unchanged'
);
select is(fsm_core.jsonb_deep_merge(NULL, NULL), NULL, 'merging NULL with NULL returns NULL');
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{"a": "value2"}'::jsonb, '{}'::jsonb) $$,
  $$ values ('{"a": "value2"}'::jsonb) $$,
  'merging with an empty object b leaves a unchanged'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{}'::jsonb, '{}'::jsonb) $$,
  $$ values ('{}'::jsonb) $$,
  'merging two empty objects gives an empty object'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{}'::jsonb, NULL) $$,
  $$ values ('{}'::jsonb) $$,
  'merging an empty object with NULL b returns the empty object'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('{"a": "value2"}'::jsonb, '"just a string"'::jsonb) $$,
  $$ values ('"just a string"'::jsonb) $$,
  'top-level object merged with a scalar b: b (the scalar) wins entirely'
);
select results_eq(
  $$ select fsm_core.jsonb_deep_merge('"just a string"'::jsonb, '{"a": "value2"}'::jsonb) $$,
  $$ values ('{"a": "value2"}'::jsonb) $$,
  'top-level scalar merged with an object b: b (the object) wins entirely'
);

-- Tier 2: fsm_core.build_nested_json_recursive
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(ARRAY[
       'machine',
       'machine.creditCheck',
       'machine.creditCheck.Entering Information',
       'machine.creditCheck.Entering Information.CheckingCreditScores',
       'machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin'
     ]) $$,
  $$ values ('{"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": "CheckingEquiGavin"}}}}'::jsonb) $$,
  'builds a fully nested object from an ordered chain of paths (last segment is a scalar leaf, not {leaf: null})'
);
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(ARRAY['machine']) $$,
  $$ values ('{"machine": null}'::jsonb) $$,
  'a single path becomes {"segment": null}'
);
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(ARRAY[
       'machine', 'machine.creditCheck', 'machine.creditCheck.Entering Information',
       'machine.creditCheck.CheckingCreditScores'
     ]) $$,
  $$ values ('{"machine": {"creditCheck": "CheckingCreditScores"}}'::jsonb) $$,
  'a shorter sibling path collapses the branch to a scalar leaf (documented current behavior)'
);
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(ARRAY[
       'machine', 'machine.creditCheck', 'machine.creditCheck.CheckingCreditScores',
       'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin',
       'machine.creditCheck.CheckingCreditScores.CheckingGavUnion',
       'machine.creditCheck.CheckingCreditScores.CheckingGavperian',
       'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport',
       'machine.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport',
       'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExisting'
     ]) $$,
  $$ values ('{"machine": {"creditCheck": {"CheckingCreditScores": {"CheckingGavUnion": "CheckingForExistingReport", "CheckingEquiGavin": "CheckingForExistingReport", "CheckingGavperian": "CheckingForExisting"}}}}'::jsonb) $$,
  'a realistic multi-branch path set builds the expected nested tree'
);
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(NULL) $$,
  $$ values ('{}'::jsonb) $$,
  'NULL paths array returns an empty object'
);
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(ARRAY['machine', NULL]) $$,
  $$ values ('{"machine": null}'::jsonb) $$,
  'NULL elements in the paths array are filtered out'
);
select results_eq(
  $$ select fsm_core.build_nested_json_recursive(ARRAY['', '']) $$,
  $$ values ('{}'::jsonb) $$,
  'empty-string-only paths array returns an empty object'
);

-- Tier 2: fsm_core.jsonb_all_paths
select results_eq(
  $$ select fsm_core.jsonb_all_paths('{
       "creditCheck": {
         "CheckingCreditScores": {
           "CheckingEquiGavin": "CheckingForExistingReport",
           "CheckingGavUnion": "CheckingForExistingReport",
           "CheckingGavperian": "CheckingForExistingReport"
         }
       }
     }'::jsonb, '') $$,
  $$ values (ARRAY[
       'creditCheck',
       'creditCheck.CheckingCreditScores',
       'creditCheck.CheckingCreditScores.CheckingGavUnion',
       'creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport',
       'creditCheck.CheckingCreditScores.CheckingEquiGavin',
       'creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport',
       'creditCheck.CheckingCreditScores.CheckingGavperian',
       'creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport'
     ]::text[]) $$,
  'extracts every intermediate and leaf path with no prefix (jsonb_each order: shortest key first, then lexicographic)'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths('{"creditCheck": {"CheckingCreditScores": "root"}}'::jsonb, 'root') $$,
  $$ values (ARRAY[
       'root.creditCheck',
       'root.creditCheck.CheckingCreditScores',
       'root.creditCheck.CheckingCreditScores.root'
     ]::text[]) $$,
  'a prefix is prepended to every extracted path (leaf scalar value is appended to its own key path)'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths('{}'::jsonb, '') $$,
  $$ values (ARRAY[]::text[]) $$,
  'an empty object with an empty prefix yields an empty array'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths('{}'::jsonb, 'root') $$,
  $$ values (ARRAY['root']::text[]) $$,
  'an empty object with a non-empty prefix yields the prefix itself as the only path'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths(NULL, '') $$,
  $$ values (ARRAY['']::text[]) $$,
  'a NULL jsonb value with an empty prefix yields a single empty-string path (current behavior)'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths(NULL, 'abcd') $$,
  $$ values (ARRAY['abcd']::text[]) $$,
  'a NULL jsonb value with a prefix yields the prefix itself as the only path (current behavior)'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths('"abcde"'::jsonb, 'abcd') $$,
  $$ values (ARRAY['abcd.abcde']::text[]) $$,
  'a scalar jsonb value appends the (unquoted) scalar to the prefix'
);
select results_eq(
  $$ select fsm_core.jsonb_all_paths('"abcde"'::jsonb, '') $$,
  $$ values (ARRAY['abcde']::text[]) $$,
  'a scalar jsonb value with no prefix is just the (unquoted) scalar'
);

-- Tier 2: fsm_core.test_jsonb_roundtrip — extract-then-rebuild is lossless for a
-- simple single-branch nested object (no scalar/object key collisions).
select results_eq(
  $$ select reconstructed from fsm_core.test_jsonb_roundtrip(
       '{"creditCheck": {"CheckingCreditScores": {"CheckingEquiGavin": "CheckingForExistingReport"}}}'::jsonb) $$,
  $$ values ('{"creditCheck": {"CheckingCreditScores": {"CheckingEquiGavin": "CheckingForExistingReport"}}}'::jsonb) $$,
  'round-tripping a simple nested object through jsonb_all_paths + build_nested_json_recursive is lossless'
);

select * from finish();
rollback;
