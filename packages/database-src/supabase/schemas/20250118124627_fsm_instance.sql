-- DROP TABLE IF EXISTS fsm_instance CASCADE;
-- DROP TABLE IF EXISTS fsm_instance_transitions_auth CASCADE;
create table fsm_core.fsm_instance (

  id uuid not null primary key default gen_random_uuid(),
  
  fsm_name text,
  fsm_version TEXT,
  fsm_type text,

  fsm_instance_context jsonb,
  fsm_instance_state jsonb,
  fsm_instance_status jsonb,
  fsm_instance_output jsonb,
  fsm_instance_error jsonb,
  fsm_instance_xstate_state jsonb,

  total_schedule_queue_data jsonb DEFAULT '[]'::jsonb,
  total_async_operation_queue_data jsonb DEFAULT '[]'::jsonb,


  -- The instance that invoked this one as a child FSM, and that invoke's id
  -- (#523). NULL for an instance started by the API, pgfsmctl or the system.
  parent_fsm_instance_id uuid,
  parent_invoke_id text,
  childrens jsonb,    
  started_at timestamp with time zone default now(),
  ended_at timestamp with time zone,

  worker_locked          boolean DEFAULT false,
  worker_locked_by       text,
  worker_locked_at       timestamp with time zone,
  worker_lock_expires_at timestamp with time zone
  
);

COMMENT ON COLUMN fsm_core.fsm_instance.parent_fsm_instance_id IS
  'The fsm_instance that invoked this one as a child FSM; NULL when started by the API, pgfsmctl or the system. When this instance finishes, that parent is sent xstate.done.actor.<parent_invoke_id> (done) or xstate.error.actor.<parent_invoke_id> (error).';
COMMENT ON COLUMN fsm_core.fsm_instance.parent_invoke_id IS
  'The parent''s invoke id for this child (XState''s child actor id), which names the events the parent gets when this instance finishes.';

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
	fsm_type text,
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



