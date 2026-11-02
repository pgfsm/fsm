-- ── Hand-written (#668): not captured by `supabase db diff` ─────────────────
-- From supabase/schemas/40_access_control/20261005120100_fsm_core_access_control.sql.
--
-- 2.2.0 (#642) granted the clock seams to fsm_worker only. Entry-point
-- functions' parameter defaults call fsm_core.tx_now(), and Postgres evaluates
-- those in the caller's context, before SECURITY DEFINER applies, so every
-- fsm_operator / fsm_admin call relying on such a default failed with
-- "permission denied for function tx_now" (e.g. POST /fsm/send with an API key).
GRANT EXECUTE ON FUNCTION fsm_core.tx_now(), fsm_core.wall_now() TO fsm_operator;
