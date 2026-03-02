-- SELECT * FROM pg_extension;
-- SELECT * FROM pg_available_extension_versions WHERE name LIKE '%pgmq%';
-- DROP EXTENSION IF EXISTS pgmq CASCADE;




CREATE EXTENSION IF NOT EXISTS ltree;

DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;
    RAISE NOTICE 'Supabase or Postgres has PGMQ installed by default. Successfully created extension pgmq with CASCADE.';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Failed to create extension pgmq with CASCADE: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;
