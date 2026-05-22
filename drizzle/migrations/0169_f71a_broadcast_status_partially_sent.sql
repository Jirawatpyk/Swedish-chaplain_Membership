-- ---------------------------------------------------------------------------
-- F7.1a US1 (Phase 3 Cluster B0) — broadcast_status enum extension.
--
-- Phase 2 gap closure: migrations 0162-0167 added F7.1a columns + tables
-- + audit-event types + RLS, but missed extending `broadcast_status`
-- pgEnum with the two new lifecycle states required by FR-008a/b:
--   - `partially_sent` (non-terminal) — entered when ≥1 batch reached
--     terminal failed state after exhausting per-batch retry budget
--   - `partial_delivery_accepted` (TERMINAL) — entered when admin
--     clicks "Accept partial delivery" on a partially_sent broadcast
--
-- Discovered 2026-05-19 during /speckit-implement Phase 3A authoring
-- of T036 cross-tenant probe — broadcast fixture needed
-- status='partially_sent' but the enum rejected it. Phase 3A workaround
-- used `sending` placeholder; this migration backfills the gap before
-- Phase 3B's use-case implementations need the values for state
-- transitions.
--
-- Postgres requirement: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction with other DDL. Each ADD VALUE ships in its own
-- statement separated by a drizzle statement-breakpoint marker so
-- drizzle-kit migrate splits them into discrete transactions.
-- Pattern matches migration 0167 (10 audit_event_type additions).
-- ---------------------------------------------------------------------------

ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'partially_sent';--> statement-breakpoint
ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'partial_delivery_accepted';--> statement-breakpoint
