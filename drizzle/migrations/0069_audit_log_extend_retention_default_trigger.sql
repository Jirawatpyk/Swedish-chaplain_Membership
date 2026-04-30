-- ---------------------------------------------------------------------------
-- F7 — audit_log retention default trigger documentation update
-- (T016 per specs/010-email-broadcast/tasks.md).
--
-- F7 (010-email-broadcast) introduces 37 new audit event types (see
-- src/modules/broadcasts/application/ports/audit-port.ts). All F7 events
-- inherit the `audit_log.retention_years` column DEFAULT 5 (Constitution
-- v1.4.0) — F7 has NO tax-document overlap (no §87/3 / §86/10 obligation;
-- no F4 / F5 receipt or credit-note touchpoint).
--
-- This migration is therefore mostly a DOCUMENTATION update — the
-- existing trigger from 0055 + 0063 already correctly handles F7 events
-- by NOT promoting them to 10y (none of the F7 event names appear in
-- the F4 tax-doc IN() list). Re-emitting the function with an extended
-- comment block:
--   1. Documents the F7-event taxonomy as deliberately falling through
--      the trigger's filter (defensive comment for future readers /
--      auditors)
--   2. Future-proofs against accidental promotion: any future PR that
--      adds an F7 event name to the trigger's IN() list will surface in
--      the diff against this comment
--
-- No backfill UPDATE required — F7 events have not yet been emitted
-- (the application-layer audit adapter that emits them lands in
-- Phase 3+ per `tasks.md` line ~120).
--
-- Atomicity: drizzle-kit wraps the migration in implicit transaction.
-- CREATE OR REPLACE FUNCTION is idempotent.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()
RETURNS TRIGGER AS $$
BEGIN
  -- F4 tax-document events promoted to 10y per Thai RD §87/3 + §86/10
  -- + GDPR Art. 6(1)(c) legal-obligation retention basis.
  IF NEW.event_type IN (
    -- Original 6 types (migration 0055):
    'invoice_issued',
    'invoice_paid',
    'invoice_voided',
    'credit_note_issued',
    'invoice_pdf_resent',
    'invoice_pdf_regenerated',
    -- Added migration 0063 — full coverage of F4_AUDIT_RETENTION_YEARS 10y types:
    'receipt_pdf_resent',
    'credit_note_pdf_resent',
    'receipt_rendered'
  ) AND NEW.retention_years < 10 THEN
    NEW.retention_years = 10;
  END IF;

  -- F7 events (broadcast_*, member_acknowledged_broadcasts_terms,
  -- member_missing_primary_contact) deliberately fall through this filter
  -- with the column DEFAULT 5. F7 has NO tax-document overlap; 5y matches
  -- Constitution v1.4.0 + F7's audit-port `F7_AUDIT_RETENTION_YEARS` map
  -- (src/modules/broadcasts/application/ports/audit-port.ts) which sets
  -- ALL 37 F7 event types to retention=5.
  --
  -- 37 F7 event types deliberately NOT in IN() above:
  --   broadcast_drafted, broadcast_submitted, broadcast_quota_blocked,
  --   broadcast_empty_segment_blocked, broadcast_rate_limit_exceeded,
  --   broadcast_not_in_plan, broadcast_immutable_after_submit,
  --   broadcast_subject_too_long, broadcast_body_too_large,
  --   broadcast_body_unsafe_html, broadcast_audience_too_large,
  --   broadcast_custom_recipient_unknown,
  --   broadcast_member_missing_primary_contact_email,
  --   member_missing_primary_contact, broadcast_member_halted_pending_review,
  --   broadcast_approved, broadcast_rejected, broadcast_cancelled,
  --   broadcast_cancel_too_late, broadcast_send_started,
  --   broadcast_send_timeout_completed, broadcast_sent,
  --   broadcast_quota_consumed, broadcast_failed_to_dispatch,
  --   broadcast_resend_resource_missing, broadcast_concurrent_action_blocked,
  --   broadcast_cross_member_probe, broadcast_cross_tenant_probe,
  --   broadcast_unsubscribed, broadcast_unsubscribe_token_invalid,
  --   broadcast_suppression_applied, broadcast_complaint_received,
  --   broadcast_webhook_signature_rejected,
  --   broadcast_sent_with_expired_member_plan,
  --   broadcast_complaint_rate_per_broadcast_breach,
  --   broadcast_member_dispatch_resumed,
  --   member_acknowledged_broadcasts_terms

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- No backfill — F7 events have not yet been emitted (Phase 3+ adapter
-- not landed). Defensive idempotent UPDATE not needed at this gate.
