CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_promise_type_worker(
    promise_queue_name text,
    queue_msg_id bigint,
    send_to_parent_queue_id uuid,
    send_event_name_to_parent_queue_id text,
    -- send_to_parent_queue_id_msg_id bigint,
    event_output jsonb,
    event_status text DEFAULT 'completed',
    event_duration integer DEFAULT NULL,
    event_finished_at timestamp with time zone DEFAULT now()
) 
RETURNS jsonb 

AS $$
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
$$ LANGUAGE plpgsql;



 -- remove event from queue promise_queue_name with queue_msg_id
 -- NOTE: push ( event_output json which has {type: send_event_name_to_parent_queue_id} from incoming msg ) on top of send_to_parent_queue_id queue ( which is not possible as PGMQ does not support priority queues below 1. and 2. will be perfomed as combine step)
 -- 1. update Sets the visibility timeout of a send_to_parent_queue_id_msg_id to immediately available for processing 
 -- 2. update send_to_parent_queue_id in workflwow_instance  for remove_promise_queue_msg_ids : TBD (pending )
 -- optional: log data event_output, event_status, event_duration, event_finished_at in promise_queue_name_logs table



-- SELECT pgmq.archive_event_from_fsm_promise_type_worker(
--   'verifyCredentials',
--   1,
--   'd88bbbf6-1083-4ec8-8e53-a8add4f69e72',
--   3,
--   jsonb_build_object(
--     'type', 'xstate.done.actor.0.(machine).creditCheck.Verifying Credentials', -- "xstate.done.actor" + "." + "0.(machine).creditCheck.Verifying Credentials"
--     'output', null
--   )
-- );