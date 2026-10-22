set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(input_fsm_name text, input_fsm_version text, input_fsm_context jsonb, create_pgmq_queue boolean DEFAULT true, input_parent_fsm_instance_id uuid DEFAULT NULL::uuid, input_parent_invoke_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
    derived_fsm_type text;
    fsm_json_exists boolean;
    fsm_instance_row      fsm_core.fsm_instance;
    declared_context jsonb;
    instance_context jsonb;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json, and
    --    read the definition's static context (SPEC-013, #584).
    SELECT true, fj.fsm_json->'context'
    INTO fsm_json_exists, declared_context
    FROM fsm_core.fsm_json fj
    WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version;

    IF NOT COALESCE(fsm_json_exists, false) THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 1.0. The instance's context (SPEC-013): the definition's static context,
    --      when fsm.json has one, shallow-merged with the context it's created
    --      with, which wins (the API payload, or an invoked child FSM's
    --      input). Without a declared context the given one is used as before.
    --      A non-object given context can't be merged: it's dropped with a
    --      warning, and the instance starts from the declared context alone.
    IF jsonb_typeof(declared_context) IS DISTINCT FROM 'object' THEN
        declared_context := NULL;
    END IF;
    IF input_fsm_context IS NULL OR jsonb_typeof(input_fsm_context) = 'null' THEN
        instance_context := COALESCE(declared_context, input_fsm_context);
    ELSIF jsonb_typeof(input_fsm_context) = 'object' THEN
        instance_context := COALESCE(declared_context, '{}'::jsonb) || input_fsm_context;
    ELSE
        RAISE WARNING 'FSM %@%: ignoring a non-object initial context (%); starting from its declared context',
            input_fsm_name, input_fsm_version, jsonb_typeof(input_fsm_context);
        instance_context := COALESCE(declared_context, '{}'::jsonb);
    END IF;

    -- 1.1. Derive fsm_type from fsm_core.fsm_dependencies: a row where this FSM
    -- is a child means it's a childfsm, otherwise it's a top-level fsm.
    IF EXISTS (
        SELECT 1
        FROM fsm_core.fsm_dependencies fd
        WHERE fd.child_fsm_name = input_fsm_name AND fd.child_fsm_version = input_fsm_version
    ) THEN
        derived_fsm_type := 'childfsm';
    ELSE
        derived_fsm_type := 'fsm';
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version, fsm_type, fsm_instance_context, parent_fsm_instance_id, parent_invoke_id)
    VALUES (input_fsm_name, input_fsm_version, derived_fsm_type, instance_context, input_parent_fsm_instance_id, input_parent_invoke_id)
    RETURNING * INTO fsm_instance_row;

    fsm_instance_id := fsm_instance_row.id;

    -- 3. Insert all transitions into fsm_core.fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_type, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT
        t.fsm_name,
        t.fsm_version,
        derived_fsm_type,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Enqueue to fsm_instance_and_fsm_workerlet and notify the fsmscheduler.
    PERFORM fsm_core.enqueue_fsm_dispatch_v2(
        fsm_instance_id,
        input_fsm_name,
        input_fsm_version,
        'start'
    );

    -- 5. Optionally create pgmq queue and send initial event
    IF create_pgmq_queue THEN
        BEGIN
            PERFORM pgmq.create(queue_name := fsm_instance_id::text);
            output_queue_created := true;
            output_message := 'Queue created successfully.';
            -- Try to send initialTransition_event to the queue
            BEGIN
                send_event_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                    input_fsm_instance_id := fsm_instance_id,
                    input_fsm_instance_id_fsm_type := derived_fsm_type,
                    input_fsm_instance_id_fsm_version := input_fsm_version,
                    input_event_name := 'initialTransition_event',
                    input_event_action_type := 'system',
                    input_event_data := jsonb_build_object('source', 'system'),
                    input_event_delay := 0,
                    input_event_status := 'fsm_started',
                    input_event_output := '{}'::jsonb,
                    input_error_message := NULL,
                    input_execution_started_at := now(),
                    input_execution_duration := NULL,
                    input_execution_finished_at := now()
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
        'queue_created', output_queue_created,
        'fsm_name', input_fsm_name,
        'fsm_version', input_fsm_version,
        'fsm_instance_id', fsm_instance_id,
        'fsm_instance_context', instance_context,
        'send_event_result', send_event_result,
        'message', output_message,
        'extra_message', output_extra_message
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_json_schema()
 RETURNS json
 LANGUAGE sql
 IMMUTABLE
AS $functionx$ SELECT '{"type":"object","$schema":"http://json-schema.org/draft-07/schema","$defs":{"actionObject":{"type":"object","properties":{"type":{"type":"string","description":"The action type"},"delayActionName":{"type":"string","description":"Required when type is xstate.raise or xstate.cancel"},"delayActionEventType":{"type":"string","description":"The event type for the delay action"}},"additionalProperties":true,"required":["type"],"if":{"properties":{"type":{"enum":["xstate.raise","xstate.cancel"]}},"required":["type"]},"then":{"properties":{"delayActionName":{"type":"string","description":"Required when type is xstate.raise or xstate.cancel"},"delayActionEventType":{"type":"string","description":"The event type for the delay action"}},"required":["delayActionName","delayActionEventType"]}},"baseStateNode":{"type":"object","properties":{"id":{"type":"string"},"key":{"type":"string"},"type":{"type":"string","enum":["atomic","compound","parallel","final","history"]},"order":{"$ref":"#/$defs/order"},"description":{"type":"string","description":"The description of the state node, in Markdown"}},"required":["id","key","type"]},"compoundStateNode":{"allOf":[{"$ref":"#/$defs/baseStateNode"},{"type":"object","properties":{"type":{"const":"compound"},"entry":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"exit":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"initial":{"$ref":"#/$defs/initialTransitionObject"},"invoke":{"$ref":"#/$defs/invokeArray"},"on":{"$ref":"#/$defs/transitionsObject"},"states":{"$ref":"#/$defs/statesObject"}},"required":["states"]}]},"parallelStateNode":{"allOf":[{"$ref":"#/$defs/baseStateNode"},{"type":"object","properties":{"type":{"const":"parallel"},"entry":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"exit":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"invoke":{"$ref":"#/$defs/invokeArray"},"on":{"$ref":"#/$defs/transitionsObject"},"states":{"$ref":"#/$defs/statesObject"}},"required":["states"]}]},"atomicStateNode":{"allOf":[{"$ref":"#/$defs/baseStateNode"},{"type":"object","properties":{"type":{"const":"atomic"},"entry":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"exit":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"invoke":{"$ref":"#/$defs/invokeArray"},"on":{"$ref":"#/$defs/transitionsObject"}},"required":["on"]}]},"historyStateNode":{"allOf":[{"$ref":"#/$defs/baseStateNode"},{"type":"object","properties":{"type":{"const":"history"},"history":{"type":"string","enum":["shallow","deep"]}},"required":["history"]}]},"finalStateNode":{"allOf":[{"$ref":"#/$defs/baseStateNode"},{"type":"object","properties":{"type":{"const":"final"},"data":{"type":"object","additionalProperties":true}}}]},"statesObject":{"type":"object","patternProperties":{"^.*$":{"oneOf":[{"$ref":"#/$defs/atomicStateNode"},{"$ref":"#/$defs/compoundStateNode"},{"$ref":"#/$defs/parallelStateNode"},{"$ref":"#/$defs/historyStateNode"},{"$ref":"#/$defs/finalStateNode"}]}}},"initialTransitionObject":{"type":"object","properties":{"actions":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"source":{"type":"string"},"target":{"type":"array","items":{"type":"string"},"minItems":1},"eventType":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["actions","source","target"]},"transitionsObject":{"type":"object","patternProperties":{"^.*$":{"type":"array","items":{"$ref":"#/$defs/transitionObject"}}}},"transitionObject":{"type":"object","properties":{"actions":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"cond":{"type":"object","additionalProperties":true,"description":"Legacy guard payload consumed by the PostgreSQL extension''s transition loader (transition->''cond''). Not emitted by this compiler, which emits `guard` instead."},"guard":{"type":"string","description":"Name of the guard function to evaluate for this transition."},"delay":{"anyOf":[{"type":"string"},{"type":"integer"}],"description":"Delay identifier (xstate.after.* transitions) or duration in ms."},"eventType":{"type":"string"},"source":{"type":"string"},"target":{"type":"array","items":{"type":"string"}}},"required":["actions","eventType","source","target"]},"invokeObject":{"type":"object","properties":{"type":{"type":"string"},"id":{"type":"string"},"src":{"type":"string"},"asyncOperationType":{"type":"string","default":"internalAsyncOperation","enum":["internalAsyncOperation","sharedAsyncOperation","fsm"],"description":"The type of the invoked service. internalAsyncOperation for a new async operation, sharedAsyncOperation for an existing async operation but shared with other FSMs, and fsm for another finite state machine."},"asyncOperationVersion":{"type":"string","description":"The version of the FSM being invoked."},"asyncOperationLanguage":{"type":"string","default":"typescript","enum":["typescript","python","rust","go","llm"],"description":"Language runtime that executes the invoked service. Defaults to typescript. Aligns with the actor folder convention (typescript/, python/, rust/, go/, llm/)."},"input":{"type":["string","number","boolean","null","array","object"],"description":"SPEC-013: the invoke''s static input, passed to the actor (or merged into an invoked child FSM''s context) unchanged. Any JSON value; a string is a value, not a reference. Mutually exclusive with inputName."},"inputName":{"type":"string","description":"SPEC-013: the input sync operation (a generated TypeScript stub taking (context, event)) the sync worker calls when the invoke starts, for an input mapper. Mutually exclusive with input."}},"required":["type","id","src","asyncOperationType","asyncOperationVersion"],"not":{"required":["input","inputName"]},"additionalProperties":false},"invokeArray":{"type":"array","items":{"$ref":"#/$defs/invokeObject"}},"functionObject":{"type":"object","properties":{"$function":{"type":"string"}}},"order":{"type":"integer"}},"properties":{"id":{"title":"ID","type":"string"},"initial":{"$ref":"#/$defs/initialTransitionObject"},"key":{"type":"string"},"type":{"type":"string","enum":["compound","parallel"]},"context":{"type":"object","additionalProperties":true},"states":{"$ref":"#/$defs/statesObject"},"on":{"$ref":"#/$defs/transitionsObject"},"transitions":{"type":"array","items":{"$ref":"#/$defs/transitionObject"}},"entry":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"exit":{"type":"array","items":{"$ref":"#/$defs/actionObject"}},"order":{"$ref":"#/$defs/order"},"invoke":{"$ref":"#/$defs/invokeArray"},"version":{"type":"string"}},"required":["id","key","type","states"]}'::json $functionx$
;


