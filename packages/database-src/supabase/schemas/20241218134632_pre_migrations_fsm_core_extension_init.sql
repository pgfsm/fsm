------------------------------------------------------------
-- Schema, tables, records, privileges, indexes, etc
------------------------------------------------------------
-- When installed as an extension, we don't need to create the `fsm_core` schema
-- because it is automatically created by postgres due to being declared in
-- the extension control file
DO
$$
BEGIN
    IF (SELECT NOT EXISTS( SELECT 1 FROM pg_extension WHERE extname = 'fsm_core')) THEN
      CREATE SCHEMA IF NOT EXISTS fsm_core;
    END IF;
END
$$;


-- note pg_jsonschema EXTENSION need schmea so using fsm_core and creating EXTENSION here
CREATE EXTENSION IF NOT EXISTS pg_jsonschema WITH SCHEMA fsm_core VERSION '0.3.3';


CREATE FUNCTION fsm_core.hello(input_text TEXT)
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Hello, %!', input_text;
END;
$$ LANGUAGE plpgsql;