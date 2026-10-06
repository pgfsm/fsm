-- API keys (SPEC-009 §2, #469)
--
-- fsm_core.api_keys stores role-scoped keys for the REST API: an admin key
-- maps to the fsm_admin Postgres role, an operator key to fsm_operator. The
-- API hashes the presented bearer key and calls verify_api_key(), then runs
-- the request under SET LOCAL ROLE <role> (see 20261005120100_fsm_core_access_control.sql).
--
-- Only sha256(key) and a short display prefix are stored. The plaintext is
-- returned once, by create_api_key(), and never again. Keys are revocable
-- one at a time (revoked_at), unlike a signed JWT.
--
-- Randomness comes from two gen_random_uuid() values (core since PG 13, CSPRNG
-- backed: 244 random bits) and hashing from core sha256(), so pgcrypto isn't
-- required.

create table if not exists fsm_core.api_keys (
  id            uuid        not null primary key default gen_random_uuid(),
  name          text        not null unique,
  role          text        not null check (role in ('fsm_admin', 'fsm_operator')),
  prefix        text        not null, -- e.g. 'pgfsm_admin_3f9a1c2e', shown by list_api_keys()
  key_hash      bytea       not null unique, -- sha256(key)
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- fsm_core.create_api_key
-- Creates a key for input_role ('fsm_admin' or 'fsm_operator') and returns
-- {id, name, role, prefix, key}. `key` is the only copy of the plaintext.
CREATE OR REPLACE FUNCTION fsm_core.create_api_key(
  input_name text,
  input_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fsm_core, pg_temp
AS $$
DECLARE
  v_key_prefix text;
  v_key        text;
  v_id         uuid;
BEGIN
  IF input_name IS NULL OR btrim(input_name) = '' THEN
    RAISE EXCEPTION 'create_api_key: name is required' USING ERRCODE = '22023';
  END IF;

  v_key_prefix := CASE input_role
    WHEN 'fsm_admin'    THEN 'pgfsm_admin_'
    WHEN 'fsm_operator' THEN 'pgfsm_op_'
  END;
  IF v_key_prefix IS NULL THEN
    RAISE EXCEPTION 'create_api_key: role must be fsm_admin or fsm_operator, got %', input_role
      USING ERRCODE = '22023';
  END IF;

  v_key := v_key_prefix || encode(
    uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');

  INSERT INTO fsm_core.api_keys (name, role, prefix, key_hash)
  VALUES (input_name, input_role, left(v_key, length(v_key_prefix) + 8),
          sha256(convert_to(v_key, 'UTF8')))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'name', input_name,
    'role', input_role,
    'prefix', left(v_key, length(v_key_prefix) + 8),
    'key', v_key
  );
END;
$$;

-- fsm_core.revoke_api_key
-- Revokes the key whose id or name is input_id_or_name. Returns TRUE if a
-- live key was revoked, FALSE if none matched or it was already revoked.
CREATE OR REPLACE FUNCTION fsm_core.revoke_api_key(
  input_id_or_name text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fsm_core, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE fsm_core.api_keys
  SET revoked_at = now()
  WHERE revoked_at IS NULL
    AND (id::text = input_id_or_name OR name = input_id_or_name);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- fsm_core.list_api_keys
-- Every key, newest first, without its hash.
CREATE OR REPLACE FUNCTION fsm_core.list_api_keys()
RETURNS TABLE (
  id           uuid,
  name         text,
  role         text,
  prefix       text,
  created_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = fsm_core, pg_temp
AS $$
  SELECT k.id, k.name, k.role, k.prefix, k.created_at, k.last_used_at, k.revoked_at
  FROM fsm_core.api_keys k
  ORDER BY k.created_at DESC;
$$;

-- fsm_core.verify_api_key
-- Returns the role of the live key whose sha256 is input_key_hash, or NULL
-- when the key is unknown or revoked. Bumps last_used_at at most once a
-- minute, so a busy API doesn't write on every request.
CREATE OR REPLACE FUNCTION fsm_core.verify_api_key(
  input_key_hash bytea
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fsm_core, pg_temp
AS $$
DECLARE
  v_id   uuid;
  v_role text;
  v_last timestamptz;
BEGIN
  SELECT k.id, k.role, k.last_used_at INTO v_id, v_role, v_last
  FROM fsm_core.api_keys k
  WHERE k.key_hash = input_key_hash AND k.revoked_at IS NULL;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_last IS NULL OR v_last < now() - interval '1 minute' THEN
    UPDATE fsm_core.api_keys SET last_used_at = now() WHERE id = v_id;
  END IF;

  RETURN v_role;
END;
$$;
