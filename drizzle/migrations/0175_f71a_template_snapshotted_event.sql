-- ---------------------------------------------------------------------------
-- R1.1 (Phase 5 Round 1 review CRIT-4) — broadcast_template_snapshotted
-- audit event type.
--
-- Adds the snapshot-moment forensic audit event emitted by snapshot-
-- template-to-draft use-case inside its withTx. Closes the audit gap
-- identified by silent-failure-hunter agent: successful snapshot
-- mutations (draft body + counter increment) had ZERO audit trail
-- pre-R1.1, leaving "who pulled which template into draft X at when"
-- invisible to forensics.
--
-- Source of truth: src/modules/broadcasts/application/ports/audit-
-- port.ts F7_AUDIT_EVENT_TYPES const tuple (event #56 of 56).
--
-- 5-year retention via Constitution v1.4.0 trigger on
-- audit_log.retention_years (no per-event grant needed).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_template_snapshotted';
