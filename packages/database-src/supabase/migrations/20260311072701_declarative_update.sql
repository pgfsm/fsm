create table "fsm_core"."fsm_instance" (
    "id" uuid not null default gen_random_uuid(),
    "fsm_name" text,
    "fsm_version" text,
    "fsm_instance_context" jsonb,
    "fsm_instance_state" jsonb,
    "fsm_instance_status" jsonb,
    "fsm_instance_output" jsonb,
    "fsm_instance_error" jsonb,
    "fsm_instance_xstate_state" jsonb,
    "total_schedule_queue_data" jsonb default '[]'::jsonb,
    "total_promise_queue_data" jsonb default '[]'::jsonb,
    "parent" uuid default '00000000-0000-0000-0000-000000000001'::uuid,
    "childrens" jsonb,
    "started_at" timestamp with time zone default now(),
    "ended_at" timestamp with time zone
);


create table "fsm_core"."fsm_instance_lock" (
    "fsm_instance_id" uuid not null,
    "locked" boolean,
    "locked_by" text,
    "locked_at" timestamp with time zone default now(),
    "expires_at" timestamp with time zone
);


create table "fsm_core"."fsm_instance_queue_event_logs" (
    "id" uuid not null default gen_random_uuid(),
    "fsm_instance_id" uuid,
    "fsm_instance_queue_msg_id" bigint,
    "event_name" text,
    "event_data" jsonb,
    "event_source" jsonb,
    "event_started_at" timestamp with time zone default now(),
    "event_duration" integer,
    "event_finished_at" timestamp with time zone default now(),
    "event_status" text,
    "event_output" jsonb,
    "error_message" text
);


create table "fsm_core"."fsm_instance_transitions_auth" (
    "id" uuid not null default gen_random_uuid(),
    "fsm_name" text,
    "fsm_version" text,
    "fsm_instance_id" uuid,
    "fsm_instance_event_type" text,
    "users" jsonb[],
    "groups" jsonb[],
    "module_tag" jsonb,
    "meta_info" jsonb
);


create table "fsm_core"."fsm_promise_queue_event_logs" (
    "id" uuid not null default gen_random_uuid(),
    "event_name" text,
    "event_input" jsonb,
    "promise_queue_name" text,
    "promise_queue_msg_id" bigint,
    "send_to_parent_queue_id" uuid,
    "send_to_parent_queue_id_msg_id" text,
    "event_started_at" timestamp with time zone default now(),
    "event_duration" integer,
    "event_finished_at" timestamp with time zone default now(),
    "event_status" text,
    "event_output" jsonb,
    "error_message" text
);


CREATE UNIQUE INDEX fsm_instance_lock_pkey ON fsm_core.fsm_instance_lock USING btree (fsm_instance_id);

CREATE UNIQUE INDEX fsm_instance_pkey ON fsm_core.fsm_instance USING btree (id);

CREATE UNIQUE INDEX fsm_instance_queue_event_logs_pkey ON fsm_core.fsm_instance_queue_event_logs USING btree (id);

CREATE UNIQUE INDEX fsm_promise_queue_event_logs_pkey ON fsm_core.fsm_promise_queue_event_logs USING btree (id);

alter table "fsm_core"."fsm_instance" add constraint "fsm_instance_pkey" PRIMARY KEY using index "fsm_instance_pkey";

alter table "fsm_core"."fsm_instance_lock" add constraint "fsm_instance_lock_pkey" PRIMARY KEY using index "fsm_instance_lock_pkey";

alter table "fsm_core"."fsm_instance_queue_event_logs" add constraint "fsm_instance_queue_event_logs_pkey" PRIMARY KEY using index "fsm_instance_queue_event_logs_pkey";

alter table "fsm_core"."fsm_promise_queue_event_logs" add constraint "fsm_promise_queue_event_logs_pkey" PRIMARY KEY using index "fsm_promise_queue_event_logs_pkey";

alter table "fsm_core"."fsm_instance_lock" add constraint "fsm_instance_lock_fsm_instance_id_fkey" FOREIGN KEY (fsm_instance_id) REFERENCES fsm_core.fsm_instance(id) not valid;

alter table "fsm_core"."fsm_instance_lock" validate constraint "fsm_instance_lock_fsm_instance_id_fkey";

alter table "fsm_core"."fsm_instance_queue_event_logs" add constraint "fsm_instance_queue_event_logs_fsm_instance_id_fkey" FOREIGN KEY (fsm_instance_id) REFERENCES fsm_core.fsm_instance(id) not valid;

alter table "fsm_core"."fsm_instance_queue_event_logs" validate constraint "fsm_instance_queue_event_logs_fsm_instance_id_fkey";

alter table "fsm_core"."fsm_instance_transitions_auth" add constraint "fsm_instance_transitions_auth_fsm_instance_id_fkey" FOREIGN KEY (fsm_instance_id) REFERENCES fsm_core.fsm_instance(id) not valid;

alter table "fsm_core"."fsm_instance_transitions_auth" validate constraint "fsm_instance_transitions_auth_fsm_instance_id_fkey";

alter table "fsm_core"."fsm_promise_queue_event_logs" add constraint "fsm_promise_queue_event_logs_send_to_parent_queue_id_fkey" FOREIGN KEY (send_to_parent_queue_id) REFERENCES fsm_core.fsm_instance(id) not valid;

alter table "fsm_core"."fsm_promise_queue_event_logs" validate constraint "fsm_promise_queue_event_logs_send_to_parent_queue_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_promise_type_worker(promise_queue_name text, queue_msg_id bigint, send_to_parent_queue_id uuid, send_event_name_to_parent_queue_id text, event_output jsonb, event_status text DEFAULT 'completed'::text, event_duration integer DEFAULT NULL::integer, event_finished_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
promise_archive_result BOOLEAN;
send_to_parent_queue_id_output_msg_id bigint;
send_to_parent_queue_id_event_output jsonb;
BEGIN
    -- 1. Remove event from queue
    promise_archive_result := pgmq.archive(queue_name := promise_queue_name, message_id := queue_msg_id);

    -- for now pushing into parent queue and assuming it will be empty so it event will be first in queue ( on top of queue)
    -- send_to_parent_queue_id_event_output := event_output
    SELECT * INTO send_to_parent_queue_id_output_msg_id FROM pgmq.send(
        queue_name := send_to_parent_queue_id::text,
        msg := jsonb_build_object(
            'type', send_event_name_to_parent_queue_id,
            'payload', event_output
        ),
        delay := 0
    );

    -- 2. (Not possible) Push event_output as msg on top of send_to_parent_queue_id queue (PGMQ does not support priority)

    -- 3. Set visibility timeout to immediately available
    -- PERFORM pgmq.set_vt(queue_name := send_to_parent_queue_id::text, msg_id := send_to_parent_queue_id_msg_id, vt := 0);

    -- 4. Update send_to_parent_queue_id in workflow_instance for remove_promise_queue_msg_ids
    -- UPDATE workflow_instance
    -- SET promise_queue_data = promise_queue_data - queue_msg_id
    -- WHERE id = send_to_parent_queue_id;

    -- 5. Log event
    INSERT INTO fsm_promise_queue_event_logs (
        event_name,
        event_input,
        promise_queue_name,
        promise_queue_msg_id,
        send_to_parent_queue_id,
        send_to_parent_queue_id_msg_id,
        event_output,
        event_status,
        event_duration,
        event_finished_at
    ) VALUES (
        'promise',
        NULL,
        promise_queue_name,
        queue_msg_id,
        send_to_parent_queue_id,
        send_to_parent_queue_id_output_msg_id,
        event_output,
        event_status,
        event_duration,
        event_finished_at
    );

    RETURN jsonb_build_object(
        'promise_queue_archive_result', promise_archive_result,
        'promise_queue_name', promise_queue_name,
        'promise_queue_msg_id', queue_msg_id,

        'parent_queue_name', send_to_parent_queue_id,
        'parent_queue_msg_id', send_to_parent_queue_id_output_msg_id

        
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_promise_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_promise_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_promise_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb)
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
    output_schedule_queue_msg_id bigint;
   
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
                        (promise_queue_entry->'event'->>'send_event_name_to_parent_queue_id')::text = (promise_queue_message->>'id')::text
                        AND (promise_queue_entry->>'promise_queue_name')::text = (promise_queue_message->>'src')::text
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
                    (promise_queue_entry->'event'->>'send_event_name_to_parent_queue_id')::text = (promise_queue_message->>'id')::text
                    AND (promise_queue_entry->>'promise_queue_name')::text = (promise_queue_message->>'src')::text
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
                PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, message_id := (schedule_queue_entry->>'type')::bigint);
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
                PERFORM fsm_core.cancel_event_for_fsm_promise_type_worker(promise_queue_entry->>'promise_queue_name', (promise_queue_entry->>'queue_msg_id')::bigint);
                confirmed_removed_promise_queue_data_success := array_append(confirmed_removed_promise_queue_data_success, promise_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 5. Send new schedule events and collect results
    IF to_be_added_schedule_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_schedule_queue_data)-1 LOOP
            to_be_added_schedule_queue_data_entry := to_be_added_schedule_queue_data->i;
            to_be_added_schedule_queue_data_entry_delay := COALESCE((to_be_added_schedule_queue_data_entry->>'delay')::integer, 0) / 1000;
            -- IF remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN
                SELECT * INTO output_schedule_queue_msg_id FROM pgmq.send(
                    queue_name := remove_from_current_fsm_instance_queue_id,
                    msg := to_be_added_schedule_queue_data_entry,
                    delay := to_be_added_schedule_queue_data_entry_delay
                );
            -- ELSE
            --     output_schedule_queue_msg_id := NULL;
            -- END IF;
            added_schedule_queue_data := array_append(added_schedule_queue_data, jsonb_build_object('queue_msg_id', output_schedule_queue_msg_id, 'event', to_be_added_schedule_queue_data_entry, 'fsm_queue_name', remove_from_current_fsm_instance_queue_id));
            new_total_schedule_queue_data := new_total_schedule_queue_data || jsonb_build_object('queue_msg_id', output_schedule_queue_msg_id, 'event', to_be_added_schedule_queue_data_entry, 'fsm_queue_name', remove_from_current_fsm_instance_queue_id);
        END LOOP;
    END IF;

    -- 6. Send new promise events and collect results
    IF to_be_added_promise_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_promise_queue_data)-1 LOOP
            to_be_added_promise_queue_data_entry := to_be_added_promise_queue_data->i;
            -- IF (to_be_added_promise_queue_data_entry->>'src') IS NOT NULL AND (to_be_added_promise_queue_data_entry->>'src') <> '' THEN
                output_promise_result := fsm_core.send_event_to_fsm_promise_queue_from_fsm_instance_id(
                    to_be_added_promise_queue_data_entry->>'id', -- type can be also used here 
                    to_be_added_promise_queue_data_entry->'input',
                    to_be_added_promise_queue_data_entry->>'src',
                    remove_from_current_fsm_instance_queue_id::uuid
                    -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                );
            -- ELSE
            --     output_promise_result := NULL;
            -- END IF;
            added_promise_queue_data := array_append(added_promise_queue_data, output_promise_result);
            new_total_promise_queue_data := new_total_promise_queue_data ||  output_promise_result;
        END LOOP;
    END IF;

    -- 7. Update fsm_instance (pseudo-code, adjust as needed)
    UPDATE fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_promise_queue_data = new_total_promise_queue_data,
        fsm_instance_status = fsm_instance_data_save_fsm_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. All above macro steps are completed so remove current queue_msg_id from current_workflow_queue_id  
    PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, message_id := remove_current_queue_msg_id::bigint);


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
         'old_total_promise_queue_data', input_total_promise_queue_data
      );

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.cancel_event_for_fsm_promise_type_worker(promise_type_worker_name text, queue_msg_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
   archive_result BOOLEAN;
BEGIN
   --  1. Remove queue_msg_id from the promise_type_worker_name queue using PGMQ
   -- IF promise_type_worker_name IS NOT NULL AND promise_type_worker_name <> '' AND queue_msg_id IS NOT NULL THEN
       archive_result := pgmq.archive(queue_name := promise_type_worker_name, message_id := queue_msg_id);
   -- ELSE
   --    archive_result := false;
   -- END IF;

    -- 2. Notify all workers via pg_notify (only when queue name present)
    -- IF promise_type_worker_name IS NOT NULL AND promise_type_worker_name <> '' THEN
        PERFORM pg_notify('fsm_promise_worker_' || promise_type_worker_name, COALESCE(queue_msg_id::text, ''));
    -- END IF;

    -- 3. Log event to fsm_promise_queue_event_logs (allow null queue id but record name)
    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        event_name,
        event_input,
        promise_queue_name,
        promise_queue_msg_id,
        -- send_to_parent_queue_id,
        -- send_to_parent_queue_id_msg_id,
        event_status,
        event_finished_at
    ) VALUES (
        'cancel',
        NULL,
        promise_type_worker_name,
        queue_msg_id,
        'canceled',
        now()
    );

    RETURN jsonb_build_object(
        'archive_result', archive_result,
        'promise_queue_name', promise_type_worker_name,
        'queue_msg_id', queue_msg_id,
        'status', 'canceled'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name(input_fsm_name text, input_fsm_version text, create_pgmq_queue boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
BEGIN
    -- 1. Find all transitions for the given FSM name and version
    IF NOT EXISTS (
        SELECT 1 FROM fsm_core.fsm_transitions WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version
    ) THEN
        RAISE EXCEPTION 'No transitions found for FSM name % and version %', input_fsm_name, input_fsm_version;
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version)
    VALUES (input_fsm_name, input_fsm_version)
    RETURNING id INTO fsm_instance_id;

    -- 3. Insert all transitions into fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT 
        t.fsm_name,
        t.fsm_version,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Optionally create pgmq queue and send initial event
    IF create_pgmq_queue THEN
        BEGIN
            PERFORM pgmq.create(fsm_instance_id::text);
            output_queue_created := true;
            output_message := 'Queue created successfully.';
            -- Try to send initialTransition_event to the queue
            BEGIN
                send_event_result := fsm_core.send_event_to_queue_with_event_logs_v2(
                    jsonb_build_object('type', 'initialTransition_event'),
                    jsonb_build_object('source', 'system'),
                    'initialTransition_event',
                    0,
                    fsm_instance_id
                );
                output_extra_message := 'initialTransition_event is also sent to queue.';
            EXCEPTION WHEN OTHERS THEN
                output_extra_message := SQLERRM;
            END;
        EXCEPTION WHEN OTHERS THEN
            output_queue_created := false;
            output_message := SQLERRM;
        END;
    ELSE
        output_queue_created := false;
        output_message := 'queue_created is false and no queue is created.';
        output_extra_message := NULL;
    END IF;

    RETURN jsonb_build_object(
        'fsm_instance_id', fsm_instance_id,
        'fsm_name', input_fsm_name,
        'fsm_version', input_fsm_version,
        'queue_created', output_queue_created,
        'message', output_message,
        'extra_message', output_extra_message,
        'send_event_result', send_event_result
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(p_fsm_instance_id uuid, p_locked_by text)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    -- Step 1: Check if the fsm_instance_id exists in referenced table
    IF NOT EXISTS (
        SELECT 1 FROM fsm_core.fsm_instance WHERE id = p_fsm_instance_id
    ) THEN
        RETURN FALSE;  -- Or raise an exception if required
    END IF;

    -- Step 2: Try to insert or update lock
    INSERT INTO fsm_core.fsm_instance_lock (
        fsm_instance_id, locked, locked_by, locked_at
    )
    VALUES (
        p_fsm_instance_id, TRUE, p_locked_by, now()
    )
    ON CONFLICT (fsm_instance_id)
    DO UPDATE
    SET locked = TRUE,
        locked_by = EXCLUDED.locked_by,
        locked_at = now(),
        expires_at = NULL
    WHERE fsm_instance_lock.locked = FALSE;

    -- Step 3: Check if insert/update actually happened
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    RETURN updated_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_promise_queue_from_fsm_instance_id(event_name text, event_input jsonb, promise_queue_name text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    queue_exists boolean := false;
    queue_msg_id bigint;
    -- queue_msg_id bigint := NULL;
    start_promise_worker boolean := false;
BEGIN
    -- 1. If queue name is present, ensure queue exists (meta check could be added)
    IF NOT queue_exists THEN
        -- IF promise_queue_name IS NOT NULL AND promise_queue_name <> '' THEN
            PERFORM pgmq.create(queue_name := promise_queue_name);
            start_promise_worker := true;
        -- END IF;
    END IF;

    -- 2. Send event to queue only when a queue name is provided
    -- IF promise_queue_name IS NOT NULL AND promise_queue_name <> '' THEN
        SELECT * INTO queue_msg_id FROM pgmq.send(
          queue_name := promise_queue_name,
          msg := jsonb_build_object(
             'type', 'promise',
             'event_input', event_input,
             'send_event_name_to_parent_queue_id', event_name,
             'send_to_parent_queue_id', from_source_fsm_instance_id
          ),
          delay := 0
       );
    -- END IF;

    -- 3. Log event (log even if queue_msg_id is NULL)
    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        event_name,
        event_input,
        promise_queue_name,
        promise_queue_msg_id,
        send_to_parent_queue_id,
        send_to_parent_queue_id_msg_id,
        event_status,
        event_finished_at
    ) VALUES (
        event_name,
        event_input,
        promise_queue_name,
        queue_msg_id,
        from_source_fsm_instance_id,
        event_name,
        'sent',
        now()
    );

    -- 4. Return result
    RETURN jsonb_build_object(
        'promise_queue_name', promise_queue_name,
        'queue_msg_id', queue_msg_id,
        'event', jsonb_build_object(
                'type', 'promise',
                'event_data', event_input,
                'send_event_name_to_parent_queue_id', event_name,
                'send_to_parent_queue_id', from_source_fsm_instance_id
            ),
        'start_promise_worker', start_promise_worker
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_queue_with_event_logs_v2(input_msg jsonb, input_event_source jsonb, input_event_name text DEFAULT NULL::text, input_event_delay integer DEFAULT 0, input_fsm_instance_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    output_fsm_instance_queue_msg_id bigint;
    fsm_instance_queue_name text;
    fsm_instance_queue_event_logs_id uuid;
BEGIN
    IF input_fsm_instance_id IS NULL THEN
        RAISE EXCEPTION 'fsm_instance_id is NULL';
    END IF;

    fsm_instance_queue_name := input_fsm_instance_id::text;


    -- Call pgmq.send and get queue_msg_id
    BEGIN
        SELECT pgmq.send(fsm_instance_queue_name, input_msg, input_event_delay) INTO output_fsm_instance_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', fsm_instance_queue_name, SQLERRM;
    END;
    IF output_fsm_instance_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', fsm_instance_queue_name;
    END IF;

    -- Insert into fsm_instance_queue_event_logs and get id
    INSERT INTO fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_data,
        fsm_instance_queue_msg_id,
        event_source,
        event_started_at,
        event_status
    ) VALUES (
        input_fsm_instance_id,
        input_event_name,
        input_msg,
        output_fsm_instance_queue_msg_id,
        input_event_source,
        now(),
        'queued'
    ) RETURNING id INTO fsm_instance_queue_event_logs_id;

    RETURN jsonb_build_object(
        'event_data', input_msg,
        'fsm_instance_queue_name', fsm_instance_queue_name,
        'fsm_instance_queue_msg_id', output_fsm_instance_queue_msg_id,
        'fsm_instance_queue_event_logs_id', fsm_instance_queue_event_logs_id
    );

    -- RETURN QUERY SELECT fsm_instance_event_logs_id, v_queue_msg_id, input_msg;

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(p_fsm_instance_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    -- Try to update the lock to unlock it
    UPDATE fsm_core.fsm_instance_lock
    SET locked = FALSE,
        locked_by = NULL,
        locked_at = NULL,
        expires_at = NULL
    WHERE fsm_instance_id = p_fsm_instance_id
      AND locked = TRUE;

    -- Check if the row was updated
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    -- If updated_count > 0, it means it was successfully unlocked
    RETURN updated_count > 0;
END;
$function$
;


