create schema if not exists "fsm_core";
create extension if not exists "pg_jsonschema" with schema "fsm_core" version '0.3.3';

CREATE FUNCTION fsm_core.hello(input_text TEXT)
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Hello, %!', input_text;
END;
$$ LANGUAGE plpgsql;