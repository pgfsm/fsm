-- SELECT * FROM pg_extension;
-- SELECT * FROM pg_available_extension_versions WHERE name LIKE '%pgmq%';
-- DROP EXTENSION IF EXISTS pgmq CASCADE;





DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;
    RAISE NOTICE 'Supabase or Postgres has PGMQ installed by default. Successfully created extension pgmq with CASCADE.';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Failed to create extension pgmq with CASCADE: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.create(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pgmq.create(queue_name := queue_name);
END;
$function$;




CREATE OR REPLACE FUNCTION public.archive(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN pgmq.archive(queue_name := queue_name, msg_id := message_id);
END;
$function$;

COMMENT ON FUNCTION public.archive(text, bigint) IS 'Archives a message by moving it from the queue to a permanent archive.';



CREATE OR REPLACE FUNCTION public.archive(queue_name text, message_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.archive(queue_name := queue_name, msg_ids := message_ids);
END;
$function$;






CREATE OR REPLACE FUNCTION public.delete(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN pgmq.delete(queue_name := queue_name, msg_id := message_id);
END;
$function$;

COMMENT ON FUNCTION public.delete(text, bigint) IS 'delete a message by moving it from the queue to a permanent delete.';



CREATE OR REPLACE FUNCTION public.delete(queue_name text, message_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.delete(queue_name := queue_name, msg_ids := message_ids);
END;
$function$;



CREATE OR REPLACE FUNCTION public.drop_queue(queue_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  return pgmq.drop_queue(queue_name := queue_name);
END;
$function$;



CREATE OR REPLACE FUNCTION public.list_queues()
 RETURNS SETOF pgmq.queue_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.list_queues();
END;
$function$;



CREATE OR REPLACE FUNCTION public.pop(queue_name text)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.pop(queue_name := queue_name);
END;
$function$;



CREATE OR REPLACE FUNCTION public.purge_queue(queue_name text)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT * FROM pgmq.purge_queue(queue_name);
END;
$function$;



CREATE OR REPLACE FUNCTION public.read(queue_name text, vt integer, qty integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.read(queue_name := queue_name, vt := vt, qty := qty);
END;
$function$;



CREATE OR REPLACE FUNCTION public.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.send(queue_name := queue_name, msg := msg, delay := delay);
END;
$function$;


CREATE OR REPLACE FUNCTION public.set_vt(queue_name text, message_id bigint, vt_offset integer)
 RETURNS SETOF pgmq.message_record
 LANGUAGE plpgsql
 SET search_path TO ''
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.set_vt(queue_name := queue_name, msg_id := message_id, vt_offset := vt_offset);
END;
$function$;


