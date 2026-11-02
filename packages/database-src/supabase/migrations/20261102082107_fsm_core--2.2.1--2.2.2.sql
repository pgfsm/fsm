-- ── Hand-written (#661): not captured by `supabase db diff` ─────────────────
-- From supabase/schemas/40_access_control/20261005120100_fsm_core_access_control.sql.
--
-- Operators can read loaded definitions, for `pgfsmctl fsm list|get` over the
-- API with an operator key. Loading them stays admin-only (load_fsm_from_json_v2).
GRANT SELECT ON fsm_core.fsm_json TO fsm_operator;
