


-- -- SET ROLE supabase_admin;

-- DROP EXTENSION IF EXISTS pgmq CASCADE;
CREATE EXTENSION IF NOT EXISTS pgmq;
-- CREATE FUNCTION create_extension_pgmq() RETURNS void AS $$
-- BEGIN
--     -- SET ROLE authenticated;
--     CREATE EXTENSION IF NOT EXISTS pgmq;
-- END;
-- $$ LANGUAGE plpgsql SECURITY DEFINER;

-- -- ALTER EXTENSION pgmq OWNER TO anon, authenticated, service_role;







-- GRANT USAGE ON SCHEMA pgmq TO anon, authenticated, service_role;
-- GRANT CREATE ON SCHEMA pgmq TO anon, authenticated, service_role;

-- -- -- GRANT USAGE, CREATE ON SCHEMA pgmq TO anon, authenticated, service_role;

-- GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO anon, authenticated, service_role;
-- GRANT ALL ON ALL ROUTINES IN SCHEMA pgmq TO anon, authenticated, service_role;
-- GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO anon, authenticated, service_role;

-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO anon, authenticated, service_role;

-- ALTER DEFAULT PRIVILEGES  IN SCHEMA pgmq GRANT ALL ON TABLES TO anon, authenticated, service_role;
-- ALTER DEFAULT PRIVILEGES  IN SCHEMA pgmq GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
-- ALTER DEFAULT PRIVILEGES  IN SCHEMA pgmq GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
-- GRANT ALL PRIVILEGES ON SCHEMA pgmq TO anon, authenticated, service_role;




-- DROP FUNCTION public.create(text);

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



-- DROP FUNCTION public.archive(text, bigint);

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


-- DROP FUNCTION public.archive(text, bigint[]);

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





-- DROP FUNCTION public.delete(text, bigint);

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


-- DROP FUNCTION public.delete(text, bigint[]);

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


-- DROP FUNCTION public.drop_queue(text);

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


-- DROP FUNCTION public.list_queues();

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


-- DROP FUNCTION public.pop(text);

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


-- DROP FUNCTION public.purge_queue(text);

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


-- DROP FUNCTION public.read(queue_name text, vt integer, qty integer);

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


-- DROP FUNCTION public.send(queue_name text, msg jsonb, delay integer DEFAULT 0)

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





-- SELECT * FROM public.create('my_queue')



create or replace function public.pg_try_advisory_lock(key bigint)
returns boolean
language sql
volatile
as $$
  select pg_try_advisory_lock($1);
$$;

create or replace function public.pg_try_advisory_lock(key1 int, key2 int)
returns boolean
language sql
volatile
as $$
  select pg_try_advisory_lock($1, $2);
$$;

-- 👇 Create wrapper for pg_advisory_unlock
create or replace function public.pg_advisory_unlock(key bigint)
returns boolean
language sql
volatile
as $$
  select pg_advisory_unlock($1);
$$;

create or replace function public.pg_advisory_unlock(key1 int, key2 int)
returns boolean
language sql
volatile
as $$
  select pg_advisory_unlock($1, $2);
$$;