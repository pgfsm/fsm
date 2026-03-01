create schema if not exists "fsm_core";

create type "fsm_core"."fsm_state_type" as enum ('atomic', 'compound', 'parallel', 'final', 'history');

create sequence "fsm_core"."fsm_transitions_id_seq";

create table "fsm_core"."fsm_states" (
    "state_id_with_fsm_name_and_fsm_version" text not null,
    "id" text not null,
    "computed_state_id_ltree" ltree not null,
    "key" text not null,
    "computed_state_key_ltree" ltree not null,
    "parent_node" text,
    "type" fsm_core.fsm_state_type not null,
    "description" text,
    "fsm_order" integer,
    "context" jsonb,
    "states" jsonb,
    "initial" jsonb,
    "fsm_on" jsonb,
    "transitions" jsonb,
    "entry" jsonb,
    "exit" jsonb,
    "invoke" jsonb,
    "data" jsonb,
    "history" text,
    "fsm_version" text,
    "fsm_name" text
);


create table "fsm_core"."fsm_transitions" (
    "id" integer not null default nextval('fsm_core.fsm_transitions_id_seq'::regclass),
    "actions" jsonb,
    "cond" jsonb,
    "event_type" text not null,
    "source" text not null,
    "computed_sanitized_source_ltree" ltree not null,
    "target" text[],
    "computed_sanitized_target_ltree_array" ltree[],
    "reenter" boolean default false,
    "computed_transition_domain_lca" text,
    "fsm_name" text,
    "fsm_version" text
);


alter sequence "fsm_core"."fsm_transitions_id_seq" owned by "fsm_core"."fsm_transitions"."id";

CREATE UNIQUE INDEX fsm_states_pkey ON fsm_core.fsm_states USING btree (state_id_with_fsm_name_and_fsm_version);

CREATE UNIQUE INDEX fsm_transitions_pkey ON fsm_core.fsm_transitions USING btree (id);

alter table "fsm_core"."fsm_states" add constraint "fsm_states_pkey" PRIMARY KEY using index "fsm_states_pkey";

alter table "fsm_core"."fsm_transitions" add constraint "fsm_transitions_pkey" PRIMARY KEY using index "fsm_transitions_pkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.archive(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN pgmq.archive(queue_name := queue_name, msg_id := message_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive(queue_name text, message_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.archive(queue_name := queue_name, msg_ids := message_ids);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.build_nested_json_recursive(paths text[])
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  result JSONB := '{}'::JSONB;
  path TEXT;
  sorted_paths TEXT[];
BEGIN
  -- Handle NULL input
  IF paths IS NULL THEN
    RETURN result;
  END IF;

  -- Sort paths by their character length (shorter paths first).
  -- Also filter out NULL or empty-string elements to avoid creating "null" keys.
  SELECT array_agg(p) INTO sorted_paths
  FROM (
    SELECT p
    FROM unnest(paths) AS p
    WHERE p IS NOT NULL AND trim(p) <> ''
    ORDER BY char_length(p) ASC
  ) s;

  -- If nothing remains after filtering, return empty object
  IF sorted_paths IS NULL THEN
    RETURN result;
  END IF;

  FOREACH path IN ARRAY sorted_paths LOOP
    result := fsm_core.jsonb_deep_merge(result, fsm_core.path_string_to_jsonb(path));
  END LOOP;

  RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core."create"(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM pgmq.create(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.delete(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN pgmq.delete(queue_name := queue_name, msg_id := message_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.delete(queue_name text, message_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.delete(queue_name := queue_name, msg_ids := message_ids);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.drop_queue(queue_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  return pgmq.drop_queue(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_proper_ancestors(state_path_ltree text, to_state_path_ltree text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    ancestors TEXT[] := ARRAY[]::TEXT[];
    current_path ltree;
    to_path ltree;
    parent_path ltree;
BEGIN
    -- Convert input to ltree
    current_path := state_path_ltree::ltree;
    to_path := to_state_path_ltree::ltree;

    -- If both are equal, return empty array
    IF current_path = to_path THEN
        RETURN ancestors;
    END IF;

    -- Walk up the tree, collecting parents, until to_path or root
    parent_path := subpath(current_path, 0, nlevel(current_path) - 1);

    WHILE nlevel(parent_path) > 0 AND parent_path <> to_path LOOP
        ancestors := array_append(ancestors, parent_path::TEXT);
        parent_path := subpath(parent_path, 0, nlevel(parent_path) - 1);
    END LOOP;

    RETURN ancestors;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_proper_ancestors_ltree(state_path_ltree ltree, to_state_path_ltree ltree)
 RETURNS ltree[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    ancestors ltree[] := ARRAY[]::ltree[];
    parent_path ltree;
BEGIN
    -- If both are equal, return empty array
    IF state_path_ltree = to_state_path_ltree THEN
        RETURN ancestors;
    END IF;

    -- Start from the immediate parent
    parent_path := subpath(state_path_ltree, 0, nlevel(state_path_ltree) - 1);

    WHILE nlevel(parent_path) > 0 AND parent_path <> to_state_path_ltree LOOP
        ancestors := array_append(ancestors, parent_path);
        parent_path := subpath(parent_path, 0, nlevel(parent_path) - 1);
    END LOOP;

    RETURN ancestors;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.hello(input_text text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE NOTICE 'Hello, %!', input_text;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.jsonb_all_paths(j jsonb, prefix text DEFAULT ''::text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    result text[] := ARRAY[]::text[];
    rec record;
    new_prefix text;
BEGIN
  -- Guard against NULL input
  -- IF j IS NULL THEN
  --   RETURN result;
  -- END IF;
  
  IF jsonb_typeof(j) = 'object' THEN
    -- if length of object is zero, return the current prefix as only path
    IF j = '{}'::jsonb THEN
      RAISE NOTICE 'Empty object encountered at prefix: %', prefix;
      IF prefix = '' THEN
        RETURN ARRAY[]::text[];
      ELSE
        RETURN ARRAY[prefix];
      END IF;
    ELSE
      FOR rec IN SELECT key, value FROM jsonb_each(j) LOOP
              new_prefix := CASE WHEN prefix = '' THEN rec.key ELSE prefix || '.' || rec.key END;
              RAISE NOTICE 'Current prefix: %', new_prefix;
              result := result || new_prefix;
              RAISE NOTICE 'current result array: %', result;
              RAISE NOTICE 'Recursing into value: % with new prefix: %', rec.value, new_prefix;
              result := result || fsm_core.jsonb_all_paths(rec.value, new_prefix);
      END LOOP;
    END IF;  
        
        
  ELSIF jsonb_typeof(j) = 'array' THEN
        -- Optionally handle arrays if needed
  ELSE
        RAISE NOTICE 'Leaf value reached at prefix: % and json value: %', prefix, j;
        -- -- It's a leaf value, append the value to the path
        IF j IS NULL THEN
            RAISE NOTICE 'Leaf value is NULL at prefix: %', prefix;
            result := result || prefix;
        ELSE
          IF prefix <> '' THEN
              -- result := result || (prefix || '.' || j::text);
              RAISE NOTICE 'Appending leaf value to path:';
              result := result || (prefix || '.' || trim(both '"' from j::text));
          ELSE
              RAISE NOTICE 'Appending leaf value to path with no prefix:';
              result := result || trim(both '"' from j::text);
          END IF;
        END IF;  
        
  END IF;
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.jsonb_deep_merge(a jsonb, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    key_ text;
    aval jsonb;
    bval jsonb;
    merged jsonb := a;
    scalar_key text;
BEGIN
    IF a IS NULL THEN
        RETURN b;
    ELSIF b IS NULL THEN
        RETURN a;
    END IF;

    IF jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
        FOR key_, bval IN
            SELECT key AS key_, value AS bval FROM jsonb_each(b)
        LOOP
            aval := a->key_;
            IF aval IS NULL THEN
                merged := jsonb_set(merged, ARRAY[key_], bval, true);
            ELSE
                IF jsonb_typeof(aval) = 'object' AND jsonb_typeof(bval) <> 'object' THEN
                    -- merge object and scalar: add scalar as key with null value
                    IF jsonb_typeof(bval) = 'string' THEN
                        scalar_key := trim(both '"' from bval::text);
                    ELSE
                        scalar_key := bval::text;
                    END IF;
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        fsm_core.jsonb_deep_merge(aval, jsonb_build_object(scalar_key, NULL)),
                        true
                    );
                ELSIF jsonb_typeof(aval) <> 'object' AND jsonb_typeof(bval) = 'object' THEN
                    -- merge scalar and object: add scalar as key with null value
                    IF jsonb_typeof(aval) = 'string' THEN
                        scalar_key := trim(both '"' from aval::text);
                    ELSE
                        scalar_key := aval::text;
                    END IF;
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        fsm_core.jsonb_deep_merge(jsonb_build_object(scalar_key, NULL), bval),
                        true
                    );
                ELSE
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        fsm_core.jsonb_deep_merge(aval, bval),
                        true
                    );
                END IF;
            END IF;
        END LOOP;
        RETURN merged;
    ELSE
        RETURN b;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.list_queues()
 RETURNS SETOF pgmq.queue_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.list_queues();
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.path_string_to_jsonb(path text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  parts TEXT[];
BEGIN
  IF path IS NULL OR trim(path) = '' THEN
    RETURN '{}'::JSONB;
  END IF;
  parts := string_to_array(path, '.');
  IF array_length(parts, 1) = 1 THEN
    RETURN jsonb_build_object(parts[1], NULL);
  ELSIF array_length(parts, 1) = 2 THEN
    RETURN jsonb_build_object(parts[1], parts[2]::text); -- Cast to text, not JSON string
  ELSE
    RETURN jsonb_build_object(parts[1], fsm_core.path_string_to_jsonb(array_to_string(parts[2:], '.')));
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.pg_advisory_unlock(key bigint)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_advisory_unlock($1);
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.pg_advisory_unlock(key1 integer, key2 integer)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_advisory_unlock($1, $2);
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.pg_try_advisory_lock(key bigint)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_try_advisory_lock($1);
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.pg_try_advisory_lock(key1 integer, key2 integer)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_try_advisory_lock($1, $2);
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.pop(queue_name text)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.pop(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.purge_queue(queue_name text)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT * FROM pgmq.purge_queue(queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.read(queue_name text, vt integer, qty integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.read(queue_name := queue_name, vt := vt, qty := qty);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.remove_hashtag_from_text(input_text text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    sanitized_text TEXT;
BEGIN
   

    -- Step 1: Remove unwanted characters (#, (), etc.)
    sanitized_text := REGEXP_REPLACE(sanitized_text, '[#]', '', 'g');

   
    -- Step 4: Handle empty string case
    IF sanitized_text = '' THEN
        RETURN NULL;
    END IF;

    RETURN sanitized_text;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_array_to_ltree_array(input_array text[])
 RETURNS ltree[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    result LTREE[];
    element TEXT;
    sanitized_ltree LTREE;
BEGIN
    result := ARRAY[]::LTREE[];
    
    -- Handle NULL input
    IF input_array IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process each element in the array using fsm_core.sanitize_text_to_ltree
    FOREACH element IN ARRAY input_array
    LOOP
        sanitized_ltree := fsm_core.sanitize_text_to_ltree(element);
        
        -- Add to result if sanitization was successful
        IF sanitized_ltree IS NOT NULL THEN
            result := array_append(result, sanitized_ltree);
        END IF;
    END LOOP;
    
    RETURN result;
-- EXCEPTION
--     WHEN OTHERS THEN
--         -- If any conversion fails, return empty array
--         RETURN ARRAY[]::LTREE[];
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_array_to_ltree_text_array(input_array text[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    result TEXT[];
    element TEXT;
    sanitized_ltree LTREE;
BEGIN
    result := ARRAY[]::TEXT[];
    
    -- Handle NULL input
    IF input_array IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process each element in the array using fsm_core.sanitize_text_to_ltree
    FOREACH element IN ARRAY input_array
    LOOP
        sanitized_ltree := fsm_core.sanitize_text_to_ltree(element);
        
        -- Add to result if sanitization was successful
        IF sanitized_ltree IS NOT NULL THEN
            result := array_append(result, sanitized_ltree::TEXT);
        END IF;
    END LOOP;
    
    RETURN result;
-- EXCEPTION
--     WHEN OTHERS THEN
--         -- If any conversion fails, return empty array
--         RETURN ARRAY[]::LTREE[];
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_to_ltree(input_text text)
 RETURNS ltree
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    sanitized_text TEXT;
BEGIN
    -- Step 1: Replace whitespace with underscores
    sanitized_text := REGEXP_REPLACE(COALESCE(input_text, ''), '\s+', '_', 'g');

    -- Step 2: Remove unwanted characters (#, (), etc.)
    sanitized_text := REGEXP_REPLACE(sanitized_text, '[#()]', '', 'g');

    -- Step 3: Remove any characters not allowed in ltree (keep letters, numbers, _, ., -)
    sanitized_text := REGEXP_REPLACE(sanitized_text, '[^a-zA-Z0-9_.-]', '', 'g');

    -- Step 4: Handle empty string case
    IF sanitized_text = '' THEN
        RETURN NULL;
    END IF;

    RETURN sanitized_text::ltree;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.send(queue_name := queue_name, msg := msg, delay := delay);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.set_vt(queue_name text, message_id bigint, vt_offset integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.set_vt(queue_name := queue_name, msg_id := message_id, vt_offset := vt_offset);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.sql_lca_from_array(paths ltree[])
 RETURNS ltree
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
  SELECT ancestor
  FROM (
    SELECT subpath(paths[1], 0, i) AS ancestor, i
    FROM generate_series(1, nlevel(paths[1])) AS i
  ) AS candidates
  WHERE NOT EXISTS (
    SELECT 1
    FROM unnest(paths) AS input(p)
    WHERE NOT (candidates.ancestor @> input.p)
  )
  ORDER BY candidates.i DESC
  LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.test_jsonb_roundtrip(input_jsonb jsonb)
 RETURNS TABLE(original jsonb, reconstructed jsonb, paths text[])
 LANGUAGE plpgsql
AS $function$
DECLARE
    extracted_paths TEXT[];
    rebuilt_jsonb JSONB;
BEGIN
    extracted_paths := fsm_core.jsonb_all_paths(input_jsonb, '');
    rebuilt_jsonb := fsm_core.build_nested_json_recursive(extracted_paths);
    RETURN QUERY SELECT input_jsonb, rebuilt_jsonb, extracted_paths;
END;
$function$
;


set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.archive(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN pgmq.archive(queue_name := queue_name, msg_id := message_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.archive(queue_name text, message_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.archive(queue_name := queue_name, msg_ids := message_ids);
END;
$function$
;

CREATE OR REPLACE FUNCTION public."create"(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM pgmq.create(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN pgmq.delete(queue_name := queue_name, msg_id := message_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete(queue_name text, message_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.delete(queue_name := queue_name, msg_ids := message_ids);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.drop_queue(queue_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  return pgmq.drop_queue(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.list_queues()
 RETURNS SETOF pgmq.queue_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.list_queues();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.pop(queue_name text)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.pop(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_queue(queue_name text)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT * FROM pgmq.purge_queue(queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.read(queue_name text, vt integer, qty integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.read(queue_name := queue_name, vt := vt, qty := qty);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.send(queue_name := queue_name, msg := msg, delay := delay);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_vt(queue_name text, message_id bigint, vt_offset integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.set_vt(queue_name := queue_name, msg_id := message_id, vt_offset := vt_offset);
END;
$function$
;


