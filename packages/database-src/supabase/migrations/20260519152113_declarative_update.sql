drop function if exists "fsm_core"."archive_event_from_fsm_type_worker_v2"(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_promise_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_promise_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_promise_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.api_system_event_name()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT 'API_INTERNAL_EVENT'::text $function$
;

CREATE OR REPLACE FUNCTION fsm_core.api_system_queue_type()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT 'API_INTERNAL'::text $function$
;

CREATE OR REPLACE FUNCTION fsm_core.api_system_queue_uuid()
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_promise_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_promise_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_promise_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb, send_to_parent_queue_id uuid, send_to_parent_queue_type text, send_to_parent_queue_id_event_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    i int;
    
    schedule_queue_entry jsonb;
    remove_schedule boolean;
    schedule_queue_message jsonb;
    confirmed_removed_schedule_queue_data jsonb[] := '{}';
    confirmed_match_for_schedule boolean;
    not_confirmed_removed_schedule_queue_data jsonb[] := '{}';

    promise_queue_entry jsonb;
    remove_promise boolean;
    promise_queue_message jsonb;
    confirmed_removed_promise_queue_data jsonb[] := '{}';
    confirmed_match_for_promise boolean;
    not_confirmed_removed_promise_queue_data jsonb[] := '{}';
   
    to_be_added_schedule_queue_data_entry jsonb;
    to_be_added_schedule_queue_data_entry_delay int;
    output_schedule_result jsonb;
   
    to_be_added_promise_queue_data_entry jsonb;
    output_promise_result jsonb;

    new_total_schedule_queue_data jsonb := '[]'::jsonb;
    new_total_promise_queue_data jsonb := '[]'::jsonb;
    
    confirmed_removed_schedule_queue_data_success jsonb[] := '{}';
    confirmed_removed_schedule_queue_data_failed jsonb[] := '{}';

    confirmed_removed_promise_queue_data_success jsonb[] := '{}';
    confirmed_removed_promise_queue_data_failed jsonb[] := '{}';

    added_schedule_queue_data jsonb[] := '{}';
    added_promise_queue_data jsonb[] := '{}';
    parent_notify_result jsonb;
BEGIN
   

    -- 1.  Remove schedule queue messages
    -- A = 'input_total_schedule_queue_data'
    -- B = 'to_be_removed_schedule_queue_msg_ids'
    -- C = 'confirmed_removed_schedule_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_schedule_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_schedule_queue_data IS NOT NULL THEN
        new_total_schedule_queue_data := '[]'::jsonb;
        FOR schedule_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_schedule_queue_data) value
        LOOP
            remove_schedule := false;
            IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
                    schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;
                   
                    IF (
                        (schedule_queue_entry->'event'->>'send_event_name_to_parent_queue_id')::text = (schedule_queue_message->>'id')::text
                        AND (schedule_queue_entry->>'schedule_queue_name')::text = (schedule_queue_message->>'src')::text
                    ) THEN
                        remove_schedule := true;
                        
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_schedule THEN
                confirmed_removed_schedule_queue_data := array_append(confirmed_removed_schedule_queue_data, schedule_queue_entry);
            ELSE
                new_total_schedule_queue_data := array_append(new_total_schedule_queue_data, schedule_queue_entry);
            END IF;
        END LOOP;

       
    END IF;

    -- 1b. Derive not_confirmed_removed_schedule_queue_data
    -- D = B - C => not_confirmed_removed_schedule_queue_data = to_be_removed_schedule_queue_msg_ids - confirmed_removed_schedule_queue_data
    IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
            schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;
            confirmed_match_for_schedule := false;
            FOREACH schedule_queue_entry IN ARRAY confirmed_removed_schedule_queue_data LOOP
                IF (
                    (schedule_queue_entry->>'id')::text = (schedule_queue_message->>'id')::text
                    AND (schedule_queue_entry->>'src')::text = (schedule_queue_message->>'src')::text
                ) THEN
                    confirmed_match_for_schedule := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_schedule THEN
                not_confirmed_removed_schedule_queue_data := array_append(not_confirmed_removed_schedule_queue_data, schedule_queue_message);
            END IF;
        END LOOP;
    END IF;


    -- 2. Cancel events for promise type workers and remove from input_total_promise_queue_data
    -- A = 'input_total_promise_queue_data'
    -- B = 'to_be_removed_promise_queue_msg_ids'
    -- C = 'confirmed_removed_promise_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_promise_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_promise_queue_data IS NOT NULL THEN
        new_total_promise_queue_data := '[]'::jsonb;
        FOR promise_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_promise_queue_data) value
        LOOP
            remove_promise := false;
            IF to_be_removed_promise_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_promise_queue_msg_ids)-1 LOOP
                    promise_queue_message := to_be_removed_promise_queue_msg_ids->i;
                    
                    IF (
                        (promise_queue_entry->>'send_to_parent_queue_id_event_name')::text = (promise_queue_message->>'id')::text
                        AND (promise_queue_entry->>'queue_fn_name')::text = (promise_queue_message->>'src')::text
                    ) THEN
                        remove_promise := true;
                        
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_promise THEN
                confirmed_removed_promise_queue_data := array_append(confirmed_removed_promise_queue_data, promise_queue_entry);
            ELSE
                new_total_promise_queue_data := array_append(new_total_promise_queue_data, promise_queue_entry);
            END IF;
        END LOOP;

        
    END IF;

    -- 2b. Derive not_confirmed_removed_promise_queue_data
    -- D = B - C => not_confirmed_removed_promise_queue_data = to_be_removed_promise_queue_msg_ids - confirmed_removed_promise_queue_data
    IF to_be_removed_promise_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_promise_queue_msg_ids)-1 LOOP
            promise_queue_message := to_be_removed_promise_queue_msg_ids->i;
            confirmed_match_for_promise := false;
            FOREACH promise_queue_entry IN ARRAY confirmed_removed_promise_queue_data LOOP
                IF (
                    (promise_queue_entry->>'send_to_parent_queue_id_event_name')::text = (promise_queue_message->>'id')::text
                    AND (promise_queue_entry->>'queue_fn_name')::text = (promise_queue_message->>'src')::text
                ) THEN
                    confirmed_match_for_promise := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_promise THEN
                not_confirmed_removed_promise_queue_data := array_append(not_confirmed_removed_promise_queue_data, promise_queue_message);
            END IF;
        END LOOP;
    END IF;

    -- 3. Remove schedule queue messages.
    IF confirmed_removed_schedule_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_schedule_queue_data, 1), 0) LOOP
            schedule_queue_entry := confirmed_removed_schedule_queue_data[i];
            
            
            
            -- IF remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' AND schedule_queue_message->>'type' IS NOT NULL AND schedule_queue_message->>'type' <> '' THEN
                PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := (schedule_queue_entry->>'type')::bigint);
                confirmed_removed_schedule_queue_data_success := array_append(confirmed_removed_schedule_queue_data_success, schedule_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 4. Cancel events for promise type workers. 
    IF confirmed_removed_promise_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_promise_queue_data, 1), 0) LOOP
            promise_queue_entry := confirmed_removed_promise_queue_data[i];
            -- pq_name := promise_queue_entry->>'promise_queue_name';
            -- pq_msg_id := NULL;
            -- BEGIN
                -- pq_msg_id := (promise_queue_entry->>'queue_msg_id')::bigint;
            -- EXCEPTION WHEN invalid_text_representation THEN
            --     pq_msg_id := NULL;
            -- END;
            -- IF pq_name IS NOT NULL AND pq_name <> '' AND pq_msg_id IS NOT NULL THEN
                PERFORM fsm_core.cancel_event_for_fsm_promise_type_worker_v2(
                    promise_type_worker_name := (promise_queue_entry->>'queue_id')::text,
                    queue_msg_id := (promise_queue_entry->>'queue_msg_id')::bigint
                );
                confirmed_removed_promise_queue_data_success := array_append(confirmed_removed_promise_queue_data_success, promise_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 5. Send new schedule events and collect results
    IF to_be_added_schedule_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_schedule_queue_data)-1 LOOP
            to_be_added_schedule_queue_data_entry := to_be_added_schedule_queue_data->i;
            to_be_added_schedule_queue_data_entry_delay := COALESCE((to_be_added_schedule_queue_data_entry->>'delay')::integer, 0) / 1000;
            output_schedule_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                input_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_fsm_instance_id_fsm_type := to_be_added_schedule_queue_data_entry->>'fsmType',
                input_fsm_instance_id_fsm_version := to_be_added_schedule_queue_data_entry->>'fsmVersion',
                input_send_to_parent_queue_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_send_to_parent_queue_type := 'FSM OR childFSM OR sharedFSM', -- # TODO : pending 
                input_send_to_parent_queue_id_event_name := to_be_added_schedule_queue_data_entry->>'id',
                input_event_name := to_be_added_schedule_queue_data_entry->>'id',
                input_event_action_type := to_be_added_schedule_queue_data_entry->>'action_type',
                input_event_data := to_be_added_schedule_queue_data_entry->'input',
                input_event_delay := to_be_added_schedule_queue_data_entry_delay,
                input_event_status := 'ACTIVE',
                input_event_output := '{}'::jsonb,
                input_error_message := NULL
            );
            added_schedule_queue_data := array_append(added_schedule_queue_data, output_schedule_result);
            new_total_schedule_queue_data := new_total_schedule_queue_data || output_schedule_result;
        END LOOP;
    END IF;

    -- 6. Send new promise events and collect results
    IF to_be_added_promise_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_promise_queue_data)-1 LOOP
            to_be_added_promise_queue_data_entry := to_be_added_promise_queue_data->i;
            -- IF (to_be_added_promise_queue_data_entry->>'src') IS NOT NULL AND (to_be_added_promise_queue_data_entry->>'src') <> '' THEN
                -- output_promise_result := fsm_core.send_event_to_fsm_promise_queue_from_fsm_instance_id_v2(
                --     to_be_added_promise_queue_data_entry->>'id', -- type can be also used here 
                --     to_be_added_promise_queue_data_entry->'input',
                --     to_be_added_promise_queue_data_entry->>'src',
                --     remove_from_current_fsm_instance_queue_id::uuid
                --     -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                -- );

                output_promise_result := fsm_core.send_event_to_queue_from_fsm_instance_id_v2(
                    event_name := to_be_added_promise_queue_data_entry->>'id',
                    event_input := to_be_added_promise_queue_data_entry->'input',
                    id := to_be_added_promise_queue_data_entry->>'id',
                    action_type := to_be_added_promise_queue_data_entry->>'action_type',
                    src := to_be_added_promise_queue_data_entry->>'src',
                    fsmName := to_be_added_promise_queue_data_entry->>'src',
                    fsmType := to_be_added_promise_queue_data_entry->>'fsmType',
                    fsmVersion := to_be_added_promise_queue_data_entry->>'fsmVersion',
                    parentFsmName := to_be_added_promise_queue_data_entry->>'parentFsmName',
                    parentFsmVersion := to_be_added_promise_queue_data_entry->>'parentFsmVersion',
                    from_source_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid
                    -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                );
            -- ELSE
            --     output_promise_result := NULL;
            -- END IF;
            added_promise_queue_data := array_append(added_promise_queue_data, output_promise_result->'queue_data');
            new_total_promise_queue_data := new_total_promise_queue_data ||  (output_promise_result->'queue_data');
        END LOOP;
    END IF;

    -- 7. Update fsm_instance (pseudo-code, adjust as needed)
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_promise_queue_data = new_total_promise_queue_data,
        fsm_instance_status = fsm_instance_data_save_fsm_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. All above macro steps are completed so remove current queue_msg_id from current_workflow_queue_id
    PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id::bigint);

    -- 9. If FSM reached a terminal state and has a real parent queue, notify the parent
    IF (fsm_instance_data_save_fsm_status #>> '{}') IN ('done', 'stopped', 'completed', 'final')
        AND send_to_parent_queue_id IS NOT NULL
        AND send_to_parent_queue_id != fsm_core.pg_system_queue_uuid()
        AND send_to_parent_queue_id != fsm_core.api_system_queue_uuid()
    THEN
        parent_notify_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id              := send_to_parent_queue_id,
            input_fsm_instance_id_fsm_type     := send_to_parent_queue_type,
            input_fsm_instance_id_fsm_version  := NULL,
            input_send_to_parent_queue_id      := fsm_core.pg_system_queue_uuid(),
            input_send_to_parent_queue_type    := fsm_core.pg_system_queue_type(),
            input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
            input_event_name                   := send_to_parent_queue_id_event_name,
            input_event_action_type            := 'childFsm_completed',
            input_event_data                   := fsm_instance_data_save_fsm_context,
            input_event_delay                  := 0,
            input_event_status                 := 'ACTIVE',
            input_event_output                 := '{}'::jsonb,
            input_error_message                := NULL
        );
    END IF;

    RETURN jsonb_build_object(
         'confirmed_removed_schedule_queue_data_success', confirmed_removed_schedule_queue_data_success,
         'confirmed_removed_promise_queue_data_success', confirmed_removed_promise_queue_data_success,
         
         'confirmed_removed_schedule_queue_data_failed', confirmed_removed_schedule_queue_data_failed,
         'confirmed_removed_promise_queue_data_failed', confirmed_removed_promise_queue_data_failed,
         
         'not_confirmed_removed_schedule_queue_data', not_confirmed_removed_schedule_queue_data,
         'not_confirmed_removed_promise_queue_data', not_confirmed_removed_promise_queue_data,  

         'added_schedule_queue_data', added_schedule_queue_data,
         'added_promise_queue_data', added_promise_queue_data,

         'new_total_schedule_queue_data', new_total_schedule_queue_data,
         'new_total_promise_queue_data', new_total_promise_queue_data,

         'old_total_schedule_queue_data', input_total_schedule_queue_data,
         'old_total_promise_queue_data', input_total_promise_queue_data,
         'parent_notify_result', parent_notify_result
      );

END;
$function$
;


