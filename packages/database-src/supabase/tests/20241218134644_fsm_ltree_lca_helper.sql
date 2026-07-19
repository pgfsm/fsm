begin;
select plan(24);

-- Tier 1: structural
select has_function('fsm_core', 'remove_hashtag_from_text', ARRAY['text'], 'remove_hashtag_from_text(text) exists');
select has_function('fsm_core', 'sanitize_text_to_ltree', ARRAY['text'], 'sanitize_text_to_ltree(text) exists');
select has_function('fsm_core', 'sanitize_text_array_to_ltree_array', ARRAY['text[]'], 'sanitize_text_array_to_ltree_array(text[]) exists');
select has_function('fsm_core', 'sanitize_text_array_to_ltree_text_array', ARRAY['text[]'], 'sanitize_text_array_to_ltree_text_array(text[]) exists');
select has_function('fsm_core', 'sql_lca_from_array', ARRAY['ltree[]'], 'sql_lca_from_array(ltree[]) exists');
select has_function('fsm_core', 'get_proper_ancestors_ltree', ARRAY['ltree', 'ltree'], 'get_proper_ancestors_ltree(ltree, ltree) exists');
select has_function('fsm_core', 'get_proper_ancestors', ARRAY['text', 'text'], 'get_proper_ancestors(text, text) exists');

-- Tier 2: fsm_core.remove_hashtag_from_text
-- Current behavior: the function reads its local `sanitized_text` variable before
-- ever assigning it from the `input_text` parameter, so it always returns NULL
-- regardless of input. Documented here as a characterization test, not an
-- endorsement of correctness.
select results_eq(
  $$ select fsm_core.remove_hashtag_from_text('hello#world') $$,
  $$ values (NULL::text) $$,
  'remove_hashtag_from_text currently always returns NULL (input_text is never read — likely a bug)'
);

-- Tier 2: fsm_core.sanitize_text_to_ltree
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree('#text') $$,
  $$ values ('text'::ltree) $$,
  'a leading hashtag is stripped'
);
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree('#text ') $$,
  $$ values ('text_'::ltree) $$,
  'trailing whitespace becomes a trailing underscore'
);
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree('text abcd') $$,
  $$ values ('text_abcd'::ltree) $$,
  'internal whitespace becomes an underscore'
);
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree('some#text with spaces()') $$,
  $$ values ('sometext_with_spaces'::ltree) $$,
  'hashtags and parentheses are stripped, whitespace becomes underscores'
);
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree('[root.child.grandchild]') $$,
  $$ values ('root.child.grandchild'::ltree) $$,
  'square brackets are stripped, leaving a valid dotted ltree path'
);
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree(NULL) $$,
  $$ values (NULL::ltree) $$,
  'NULL input returns NULL'
);
select results_eq(
  $$ select fsm_core.sanitize_text_to_ltree('###') $$,
  $$ values (NULL::ltree) $$,
  'an input that sanitizes to an empty string returns NULL'
);

-- Tier 2: fsm_core.sanitize_text_array_to_ltree_array / _text_array
select results_eq(
  $$ select fsm_core.sanitize_text_array_to_ltree_array(ARRAY['abcd #text', '(machine)', '###']) $$,
  $$ values (ARRAY['abcd_text', 'machine']::ltree[]) $$,
  'elements that sanitize to empty are skipped from the ltree[] result'
);
select results_eq(
  $$ select fsm_core.sanitize_text_array_to_ltree_array(NULL) $$,
  $$ values (ARRAY[]::ltree[]) $$,
  'NULL input array returns an empty ltree[]'
);
select results_eq(
  $$ select fsm_core.sanitize_text_array_to_ltree_text_array(ARRAY['abcd #text', '(machine)']) $$,
  $$ values (ARRAY['abcd_text', 'machine']::text[]) $$,
  'the text[]-returning variant sanitizes the same way, as text'
);

-- Tier 2: fsm_core.sql_lca_from_array — the custom LCA implementation
-- (the file notes ltree's own built-in lca() does not work as expected here).
select results_eq(
  $$ select fsm_core.sql_lca_from_array(ARRAY['a'::ltree, 'a.b.c'::ltree, 'a.b.c.f'::ltree]) $$,
  $$ values ('a'::ltree) $$,
  'when the root itself is one of the inputs, the LCA is the root'
);
select results_eq(
  $$ select fsm_core.sql_lca_from_array(ARRAY['a.b.c.d'::ltree, 'a.b.c.e'::ltree, 'a.b.c.f'::ltree]) $$,
  $$ values ('a.b.c'::ltree) $$,
  'the common ancestor of three siblings is their shared parent path'
);
select results_eq(
  $$ select fsm_core.sql_lca_from_array(ARRAY['a.b.c.d'::ltree, 'x.y.z'::ltree]) $$,
  $$ values (NULL::ltree) $$,
  'disjoint trees have no common ancestor'
);

-- Tier 2: fsm_core.get_proper_ancestors_ltree / get_proper_ancestors
select results_eq(
  $$ select fsm_core.get_proper_ancestors_ltree('a.b.c.d'::ltree, 'a'::ltree) $$,
  $$ values (ARRAY['a.b.c', 'a.b']::ltree[]) $$,
  'walks up from the child, stopping before (excluding) the given ancestor and the ancestor itself'
);
select results_eq(
  $$ select fsm_core.get_proper_ancestors_ltree('a.b.c'::ltree, 'a.b.c'::ltree) $$,
  $$ values (ARRAY[]::ltree[]) $$,
  'equal start and stop paths yield no ancestors'
);
select results_eq(
  $$ select fsm_core.get_proper_ancestors('a.b.c.d', 'a') $$,
  $$ values (ARRAY['a.b.c', 'a.b']::text[]) $$,
  'the text-typed variant matches the ltree-typed variant'
);

select * from finish();
rollback;
