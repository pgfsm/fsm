DROP FUNCTION IF EXISTS fsm_core.get_fsm_data_resolve_state_value_v2(TEXT);
CREATE OR REPLACE FUNCTION fsm_core.get_fsm_data_resolve_state_value_v2(
    input_fsm_id TEXT
)
RETURNS JSONB AS $$
DECLARE
    fi_record fsm_core.fsm_instance;
    resolved_value JSONB;
    result_json JSONB;
BEGIN
    RAISE NOTICE '[get_fsm_data_resolve_state_value_v2] Searching for fsm_instance with id=%', input_fsm_id;
    SELECT * INTO fi_record
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_id::uuid;

    IF fi_record IS NULL THEN
        RAISE EXCEPTION '[get_fsm_data_resolve_state_value_v2] No fsm_instance found for id=%', input_fsm_id;
    END IF;

    RAISE NOTICE '[get_fsm_data_resolve_state_value_v2] Found fsm_instance, calling resolve_state_value_v2...';
    resolved_value := fsm_core.resolve_state_value_v2(fi_record.fsm_instance_state, fi_record.fsm_name, fi_record.fsm_version);

    result_json := jsonb_build_object(
        'fsm_instance_row', to_jsonb(fi_record),
        'resolved_state_value', resolved_value
    );
    RETURN result_json;
END;
$$ LANGUAGE plpgsql STABLE;