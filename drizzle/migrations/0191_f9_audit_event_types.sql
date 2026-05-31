-- ---------------------------------------------------------------------------
-- F9 (T011a) — 14 new F9 audit event types on the shared audit_event_type enum.
--
-- Source of truth: data-model.md § 7. REQUIRED before any code emits F9 events
-- (analyze H1) — mirrors the F5/F7 enum-extension pattern. F9 audit events are
-- written to the shared `audit_log` table via the insights AuditPort with
-- 5-year retention (no financial/tax records here).
--
-- Postgres requires `ADD VALUE` to be effective before the value is USED; F9
-- code emits these only after this migration applies. IF NOT EXISTS keeps the
-- migration idempotent / re-runnable. NO ordering dependency with 0190 (the
-- stale trigger keys off pre-existing event types only — critique R2-L1).
--
-- Rollback (Critique E8): Postgres cannot DROP an enum value. A clean rollback
-- recreates the enum without these labels (drop dependent defaults, ALTER TYPE
-- ... RENAME, recreate, re-cast columns) — documented but not expected; F9
-- ships dark behind FEATURE_F9_DASHBOARD so unused labels are inert.
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'dashboard_viewed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'audit_log_queried';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'audit_log_exported';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_benefit_viewed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'smart_insight_dismissed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'directory_listing_updated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'directory_ebook_generated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'directory_json_exported';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'data_export_requested';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'data_export_generated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'data_export_downloaded';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'data_export_failed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'data_export_expired';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'insights_cross_tenant_probe';
