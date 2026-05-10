-- PR #24 review-fix — search-path hardening for ALL plpgsql trigger
-- functions across F4 + F5 + F7 + F8 (defense-in-depth).
--
-- Background: every existing `CREATE OR REPLACE FUNCTION ... LANGUAGE
-- plpgsql` statement in migrations 0019, 0027, 0055, 0063, 0064, 0065,
-- 0069, 0075, 0084, 0086, 0087, 0089 omits `SET search_path = ...`.
-- Without this, a malicious user with CREATE privileges in a non-trusted
-- schema (or a future extension that registers operators in `public`)
-- can shadow built-in operators / functions called inside the trigger
-- body. Realistic exploit surface is small in our SaaS deploy because
-- the chamber_app role does not grant CREATE on user-controlled schemas
-- — but the pattern is required by Postgres security best practices and
-- the F5 review (W10) explicitly flagged it across all features.
--
-- Strategy: use `ALTER FUNCTION ... SET search_path = pg_catalog, public`
-- (NOT `CREATE OR REPLACE`). This applies the security setting WITHOUT
-- touching the function body, so there is zero risk of accidentally
-- regressing logic that was carefully iterated across multiple migration
-- amendments (e.g. broadcasts_state_machine_fn evolved across 0064/0075;
-- audit_log_default_retention extended across 0055/0063/0069/0084).
--
-- Idempotent: ALTER FUNCTION ... SET ... is safe to re-run; later runs
-- overwrite with the same value. Triggers remain bound (function OID
-- unchanged).
--
-- Note on argument-list resolution: PostgreSQL requires `()` for
-- zero-argument functions. All trigger functions are zero-arg by Postgres
-- convention (the trigger context is passed via `TG_*` magic variables,
-- not function parameters), so `()` is correct everywhere below.

-- ===========================================================================
-- F4 INVOICING (migrations 0019, 0027)
-- ===========================================================================
ALTER FUNCTION invoices_enforce_immutability() SET search_path = pg_catalog, public;
ALTER FUNCTION credit_notes_enforce_immutability() SET search_path = pg_catalog, public;

-- ===========================================================================
-- AUDIT-LOG retention default (migrations 0055 / 0063 / 0069 / 0084)
-- ===========================================================================
ALTER FUNCTION audit_log_default_retention_for_f4_tax_docs() SET search_path = pg_catalog, public;

-- ===========================================================================
-- F7 BROADCASTS (migrations 0064, 0065, 0075)
-- ===========================================================================
ALTER FUNCTION broadcasts_set_updated_at_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION broadcasts_immutable_after_submit_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION broadcasts_state_machine_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION broadcast_deliveries_append_only_fn() SET search_path = pg_catalog, public;

-- ===========================================================================
-- F8 RENEWALS (migrations 0086, 0087, 0089)
-- ===========================================================================
ALTER FUNCTION scheduled_plan_changes_set_updated_at_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION renewal_cycles_sync_expires_at_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION renewal_cycles_set_updated_at_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION tenant_renewal_settings_set_updated_at_fn() SET search_path = pg_catalog, public;
ALTER FUNCTION tenant_renewal_schedule_policies_set_updated_at_fn() SET search_path = pg_catalog, public;
