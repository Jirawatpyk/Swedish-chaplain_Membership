-- COMP-1 Member Erasure (US1) — members.erased_at + two F3 audit-event types.
--
-- erased_at: NULL until eraseMember anonymises the row. No backfill (all
-- existing members are non-erased). No index in US1 — the reconciliation
-- sweep (US2) adds a partial index when it lands. DELIVERED: the partial
-- `members_erased_at_idx` (WHERE erased_at IS NOT NULL) lands in migration
-- 0226_members_erased_at_reconciler_idx.
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "erased_at" timestamptz;
--> statement-breakpoint
-- New audit_event_type values. ADD VALUE IF NOT EXISTS is idempotent.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_erasure_requested';
--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_erased';
