------------------------------------------------------------
-- Schema, tables, records, privileges, indexes, etc
------------------------------------------------------------
-- fsm_core schema is automatically created by postgres because `schema = 'fsm_core'`
-- is declared in the .control file. ltree and pgmq are loaded automatically via
-- `requires = 'ltree, pgmq'` in the .control file before this SQL runs.

CREATE FUNCTION fsm_core.hello_world(input_text TEXT)
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Hello, %!', input_text;
END;
$$ LANGUAGE plpgsql;