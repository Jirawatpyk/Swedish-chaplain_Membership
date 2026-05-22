-- ---------------------------------------------------------------------------
-- R3.1 C-3 (Phase 5 Round 2 close-out) —
-- broadcast_template_snapshot_refused_deleted audit event type.
--
-- Distinct event for when the snapshot use-case refuses a soft-deleted
-- template (TOCTOU race after the picker rendered). Round 1 mistakenly
-- reused `broadcast_template_snapshotted` for both success + refusal,
-- breaking SIEM count filters (refusals counted as successes).
--
-- Same payload shape as the success event so forensic pivots can join
-- the two for "refusal-to-success ratio" alerts on individual templates.
--
-- Source of truth: src/modules/broadcasts/application/ports/audit-
-- port.ts F7_AUDIT_EVENT_TYPES const tuple (event #58 of 58).
--
-- 5-year retention via Constitution v1.4.0 trigger on
-- audit_log.retention_years (no per-event grant needed).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_template_snapshot_refused_deleted';
