

-- DO $$
-- BEGIN
--   -- Set the schema name for queue functions
--   -- Change 'public' to 'fsm_core' if needed
--   PERFORM set_config('schema_name_for_queue_fn', 'fsm_core', false);
-- END$$;

CREATE OR REPLACE FUNCTION fsm_core.create(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pgmq.create(queue_name := queue_name);
END;
$function$;



DROP FUNCTION IF EXISTS fsm_core.archive(queue_name text, message_id bigint);
CREATE OR REPLACE FUNCTION fsm_core.archive(queue_name text, msg_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN pgmq.archive(queue_name := queue_name, msg_id := msg_id);
END;
$function$;

COMMENT ON FUNCTION fsm_core.archive(text, bigint) IS 'Archives a message by moving it from the queue to a permanent archive.';


DROP FUNCTION IF EXISTS fsm_core.archive(queue_name text, message_ids bigint[]);
CREATE OR REPLACE FUNCTION fsm_core.archive(queue_name text, msg_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.archive(queue_name := queue_name, msg_ids := msg_ids);
END;
$function$;





DROP FUNCTION IF EXISTS fsm_core.delete(queue_name text, msg_id bigint);
CREATE OR REPLACE FUNCTION fsm_core.delete(queue_name text, msg_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN pgmq.delete(queue_name := queue_name, msg_id := msg_id);
END;
$function$;

COMMENT ON FUNCTION fsm_core.delete(text, bigint) IS 'delete a message by moving it from the queue to a permanent delete.';


DROP FUNCTION IF EXISTS fsm_core.delete(queue_name text, msg_ids bigint[]);
CREATE OR REPLACE FUNCTION fsm_core.delete(queue_name text, msg_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.delete(queue_name := queue_name, msg_ids := msg_ids);
END;
$function$;



CREATE OR REPLACE FUNCTION fsm_core.drop_queue(queue_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  return pgmq.drop_queue(queue_name := queue_name);
END;
$function$;



CREATE OR REPLACE FUNCTION fsm_core.list_queues()
 RETURNS SETOF pgmq.queue_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.list_queues();
END;
$function$;



CREATE OR REPLACE FUNCTION fsm_core.pop(queue_name text)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.pop(queue_name := queue_name);
END;
$function$;



CREATE OR REPLACE FUNCTION fsm_core.purge_queue(queue_name text)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT * FROM pgmq.purge_queue(queue_name := queue_name);
END;
$function$;



CREATE OR REPLACE FUNCTION fsm_core.read(queue_name text, vt integer, qty integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.read(queue_name := queue_name, vt := vt, qty := qty);
END;
$function$;



CREATE OR REPLACE FUNCTION fsm_core.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.send(queue_name := queue_name, msg := msg, delay := delay);
END;
$function$;

DROP FUNCTION IF EXISTS fsm_core.set_vt(queue_name text, msg_id bigint, vt_offset integer);
CREATE OR REPLACE FUNCTION fsm_core.set_vt(queue_name text, msg_id bigint, vt_offset integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.set_vt(queue_name := queue_name, msg_id := msg_id, vt_offset := vt_offset);
END;
$function$;


