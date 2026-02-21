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

CREATE OR REPLACE FUNCTION public.pg_advisory_unlock(key bigint)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_advisory_unlock($1);
$function$
;

CREATE OR REPLACE FUNCTION public.pg_advisory_unlock(key1 integer, key2 integer)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_advisory_unlock($1, $2);
$function$
;

CREATE OR REPLACE FUNCTION public.pg_try_advisory_lock(key bigint)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_try_advisory_lock($1);
$function$
;

CREATE OR REPLACE FUNCTION public.pg_try_advisory_lock(key1 integer, key2 integer)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  select pg_try_advisory_lock($1, $2);
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


