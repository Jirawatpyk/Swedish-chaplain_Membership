-- =========================================================================
-- 0150 — F6.1 (Feature 013 · R1) — close CR-5 + CR-10 audit-trail gaps
-- =========================================================================
--
-- Adds two new values to the `audit_event_type` Postgres enum so the
-- F6.1 use-cases can emit per-row forensic audit trails for:
--
--   * `csv_import_row_state_changed` (CR-5 / I-5) — receipt-duplicate
--     row whose payment_status flipped via the FR-018 Notes-inferred
--     state-change branch. Required for PDPA Art. 30 + GDPR Art. 30
--     traceable processing-records on payment-status mutations of an
--     already-persisted attendee registration.
--   * `csv_import_row_cancelled_no_prior` (CR-10) — first-time
--     Cancellation row skipped (no prior registration to refund). Lets
--     support reconstruct WHY a row appears in `rowsSkipped` separately
--     from the EventCreate Status-filter "Skipped: ..." reason string.
--
-- Mirrors the pattern from 0132 / 0137 / 0141 / 0144: idempotent
-- DO-block with EXCEPTION → NULL to allow re-runs.
--
-- Pairs with TypeScript `F6_AUDIT_EVENT_TYPES` + `AuditPayloads.*`
-- extensions in `src/modules/events/application/ports/audit-port.ts`.
-- Both layers must stay in sync; this migration is the DB half.
-- =========================================================================

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_row_state_changed';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_row_cancelled_no_prior';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
