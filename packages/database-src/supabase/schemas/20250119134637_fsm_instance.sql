-- DROP TABLE IF EXISTS fsm_instance CASCADE;
-- DROP TABLE IF EXISTS fsm_instance_transitions_auth CASCADE;
create table fsm_core.fsm_instance (

  id uuid not null primary key default gen_random_uuid(),
  
  fsm_name text,
  fsm_version TEXT,

  fsm_instance_context jsonb,
  fsm_instance_state jsonb,
  fsm_instance_status jsonb,
  fsm_instance_output jsonb,
  fsm_instance_error jsonb,
  fsm_instance_xstate_state jsonb,

  total_schedule_queue_data jsonb DEFAULT '[]'::jsonb,
  total_promise_queue_data jsonb DEFAULT '[]'::jsonb,


  parent uuid default '00000000-0000-0000-0000-000000000001', -- Self-reference, 00000000-0000-0000-0000-000000000001 for system
  childrens jsonb,    
  started_at timestamp with time zone default now(),
  ended_at timestamp with time zone
  
);

-- DO $$
-- DECLARE
--     default_comment text := '{"history": "true", "realtime": "false"}';
-- BEGIN
--     EXECUTE format('COMMENT ON TABLE %I.%I IS %L', 'public', 'fsm_instance', default_comment);
-- END $$;


create table "fsm_core"."fsm_instance_transitions_auth" (
    "id" uuid not null default gen_random_uuid(),

	"fsm_name" text,
	fsm_version text,
    "fsm_instance_id" uuid references fsm_core.fsm_instance,

    "fsm_instance_event_type" text,
	
    "users" jsonb[],
    "groups" jsonb[],
    "module_tag" jsonb,
    "meta_info" jsonb
);

-- DO $$
-- DECLARE
--     jsonComment jsonb;
-- BEGIN
--     -- Retrieve the JSON from the table
--     SELECT json_comment INTO jsonComment
--     FROM column_comment_json_storage
--     WHERE id = 1;

--     -- Use the retrieved JSON value in the comment
--     EXECUTE format('COMMENT ON COLUMN %I.%I.users IS %L', 'public', 'fsm_instance_transitions_auth', jsonComment::text);
-- END $$;

-- DO $$
-- DECLARE
--     default_comment text := '{"history": "true", "realtime": "false"}';
-- BEGIN
--     EXECUTE format('COMMENT ON TABLE %I.%I IS %L', 'public', 'fsm_instance_transitions_auth', default_comment);
-- END $$;



