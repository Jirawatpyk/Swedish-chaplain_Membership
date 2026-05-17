-- Phase B B2 — discriminate "legitimate 404 on a deleted/archived event"
-- from "confirmed cross-tenant probe" so alert rules on
-- `rate(cross_tenant_probe) > 0` don't fire on routine admin lookups.
--
-- The admin event-detail route previously emitted `cross_tenant_probe`
-- for every not_found result, causing alert fatigue (a deleted event
-- looks identical to a cross-tenant probe under RLS-secure 404
-- semantics). This new event type lowers the severity for the
-- legitimate-404 case while preserving the high-severity
-- `cross_tenant_probe` for confirmed cross-tenant access patterns.
--
-- 5-year retention (default) — see `audit_log.retention_years`.

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'event_detail_not_found_probe'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
