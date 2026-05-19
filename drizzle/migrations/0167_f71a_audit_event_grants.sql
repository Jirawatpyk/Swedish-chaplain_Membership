-- ---------------------------------------------------------------------------
-- F7.1a (T018) — 10 new audit_event_type enum values.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 7
-- + research.md § 8 + plan.md § Constitution Check VIII.
--
-- Postgres requirement: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction with other DDL statements. Each ADD VALUE ships in its
-- own statement separated by a drizzle statement-breakpoint marker so
-- drizzle-kit migrate splits them into discrete transactions. Pattern
-- matches migration 0107 (F8 cron_dispatch_orchestrated).
--
-- All 10 events default to 5-year retention via Constitution v1.4.0
-- trigger on audit_log.retention_years (no per-event retention grant
-- needed — see migration 0063 for the trigger; data-model.md confirms
-- F7.1a has no tax-document touchpoint, so 5y is appropriate).
--
-- Application-layer emit sites:
--   - audit-port.ts F7_AUDIT_EVENT_TYPES const tuple (extended in T031).
--   - Per-use-case emits land in Phase 3 (US1), Phase 4 (US2), Phase 5 (US7).
-- ---------------------------------------------------------------------------

-- --- US1 (Pagination + retry loop) — 4 events ------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_dispatched_in_batches';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_retry_initiated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_retry_completed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_partial_delivery_accepted';--> statement-breakpoint

-- --- US2 (Image embedding + allowlist + scan) — 3 events ------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_body_image_source_unsafe';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_image_too_large';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_image_allowlist_updated';--> statement-breakpoint

-- --- US7 (Template library CRUD) — 3 events --------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_template_created';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_template_updated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_template_deleted';--> statement-breakpoint
