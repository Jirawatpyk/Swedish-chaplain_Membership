-- ---------------------------------------------------------------------------
-- F9 (T006) — dashboard_metrics_cache table.
--
-- Source of truth: specs/015-admin-dashboard/data-model.md § 1 + research R1.
--
-- One row per tenant: the cached operations-dashboard snapshot (KPI counts,
-- YTD revenue, needs-attention counts, under-delivered-benefit count, top
-- insights) as a typed `DashboardSnapshot` JSONB projection. Refreshed by the
-- snapshot cron (~5 min) and marked `stale=true` by an AFTER-INSERT trigger on
-- audit_log (migration 0190) on key state-changing events. The dashboard reads
-- the single cached row (fast, bounded) and shows `computed_at` as the "as of"
-- time (FR-005). The activity feed is a SEPARATE live query (not cached).
--
-- `metrics` JSONB is a DERIVED projection, never authoritative — safe to
-- rebuild idempotently. `refresh_started_at` is a claim marker so the cold-
-- start lazy compute (list-dashboard) and the cron never double-compute.
--
-- Tenant isolation (Constitution v1.4.2 Principle I, NON-NEGOTIABLE):
--   - RLS + FORCE + tenant policy below (DB-layer).
--   - All access threads `tx` via runInTenant (app-layer) — never global db.
--   - chamber_app GRANT below (the F7.1a 0172 missing-grant incident proved
--     RLS without GRANT yields "permission denied" at runtime).
--
-- Rollback (drizzle-kit is forward-only — Critique E8):
--   DROP POLICY "tenant_isolation_on_dashboard_metrics_cache" ON "dashboard_metrics_cache";
--   DROP TABLE "dashboard_metrics_cache";
-- ---------------------------------------------------------------------------

CREATE TABLE "dashboard_metrics_cache" (
  "tenant_id"           text PRIMARY KEY,
  "metrics"             jsonb       NOT NULL,
  "computed_at"         timestamptz NOT NULL,
  "stale"               boolean     NOT NULL DEFAULT false,
  "refresh_started_at"  timestamptz
);--> statement-breakpoint

ALTER TABLE "dashboard_metrics_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboard_metrics_cache" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_dashboard_metrics_cache"
  ON "dashboard_metrics_cache"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "dashboard_metrics_cache"
  TO chamber_app;
