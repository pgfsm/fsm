set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.async_operation_messages_not_queued_v2(input_messages jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    queue record;
    present bigint[];
    missing jsonb := '[]'::jsonb;
BEGIN
    FOR queue IN
        SELECT m->>'queue_name' AS queue_name,
               array_agg((m->>'msg_id')::bigint) AS msg_ids
        FROM jsonb_array_elements(COALESCE(input_messages, '[]'::jsonb)) m
        GROUP BY m->>'queue_name'
    LOOP
        IF EXISTS (SELECT 1 FROM pgmq.list_queues() q WHERE q.queue_name = queue.queue_name) THEN
            EXECUTE format(
                'SELECT COALESCE(array_agg(msg_id), ''{}'') FROM pgmq.%I WHERE msg_id = ANY($1)',
                pgmq.format_table_name(queue.queue_name, 'q')
            ) INTO present USING queue.msg_ids;
        ELSE
            present := '{}';
        END IF;

        SELECT missing || COALESCE(jsonb_agg(jsonb_build_object('queue_name', queue.queue_name, 'msg_id', id)), '[]'::jsonb)
        INTO missing
        FROM unnest(queue.msg_ids) id
        WHERE id <> ALL (present);
    END LOOP;
    RETURN missing;
END;
$function$
;



-- Not captured by `supabase db diff` (see packages/database-src/CLAUDE.md,
-- "Access control"): the Activity Gateway's sweep calls this as fsm_worker
-- (#538).
REVOKE EXECUTE ON FUNCTION fsm_core.async_operation_messages_not_queued_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.async_operation_messages_not_queued_v2(jsonb) TO fsm_worker;
