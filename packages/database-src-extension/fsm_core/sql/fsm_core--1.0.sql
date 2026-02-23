CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgmq;

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

CREATE FUNCTION fsm_core.hello(input_text TEXT)
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Hello, %!', input_text;
END;
$$ LANGUAGE plpgsql;