-- ---------------------------------------------------------------------------
-- COMP-1 US2b — GDPR Art.17 / PDPA §33 broadcast content redaction.
--
-- (1) Amend `broadcasts_immutable_after_submit_fn` to exempt the PII content
--     columns from the post-submit immutability lock when the erasure path
--     opts in via `SET LOCAL app.allow_broadcast_redaction = 'on'`. This
--     mirrors F4's `app.allow_pii_redaction` GUC-gated exemption on the
--     invoices/credit-notes immutability triggers. Base = live function body
--     (migration 0075; verified byte-identical against the running Neon DB —
--     0124 only re-applied `SET search_path`, no logic change after 0075).
--
--     GUC ARM IS A WHITELIST (2026-06-18 /code-review #14 — closes the
--     0224-vs-0225 asymmetry). The original 0224 GUC arm was a BLOCKLIST:
--     it RAISEd only if segment_type/segment_params/scheduled_for changed,
--     leaving every OTHER immutable column (status, quota_year_consumed,
--     resend_broadcast_id, approved_by_user_id, sent_at, …) freely mutable
--     under the GUC. No live exploit (the only GUC caller —
--     `scrubContentForMemberInTx` — touches only PII content cols), but the
--     asymmetry with the sibling 0225 deliveries arm (a tight whitelist) was
--     a latent hazard. This rewrite inverts it: under the GUC, RAISE
--     `broadcast_redaction_only_pii_cols` unless the change is confined to
--     the PII content columns the erasure scrub writes —
--       subject / body_html / body_source / from_name / reply_to_email /
--       custom_recipient_emails / rejection_reason / cancellation_reason /
--       failure_reason.
--     (from_name/reply_to_email are not checked by the NON-GUC branch, but
--     the scrub writes them, so they are whitelisted here; rejection_reason
--     and cancellation_reason are nullable free-text the scrub NULLs because
--     a member-originated note can quote the member's PII. failure_reason is
--     whitelisted too — 2026-06-19 /code-review #8: it is set from the raw
--     gateway error message (dispatch-scheduled-broadcast.ts:
--     `shape.reason ?? e.message`), which can echo the broadcast's
--     reply_to_email / from_name — the author's OWN PII, the same address
--     the scrub redacts on that row — so the scrub NULLs it and the GUC arm
--     must permit that change.) Any change to a
--     NON-PII column (targeting: segment_type/segment_params; lifecycle:
--     status/timestamps/quota/resend ids/approver-rejecter-canceller ids;
--     template provenance; created_at; the composite PK
--     tenant_id/broadcast_id) still RAISEs, so the redaction path cannot be
--     abused to mutate audience targeting, the row identity, or the audit
--     trail after submit. The composite-PK columns (tenant_id + broadcast_id)
--     are enumerated explicitly (2026-06-19 /code-review #5/#6 — the original
--     whitelist omitted them; no live exploit since the scrub never touches
--     the PK, but a latent defense-in-depth gap matching the sibling 0225
--     arm, which forbids tenant_id/delivery_id/broadcast_id). Mirrors 0225's
--     enumerate-the-forbidden-cols idiom.
--
--     NOTE on `updated_at`: it is intentionally NOT enumerated below. The
--     `broadcasts_set_updated_at` trigger bumps it on every UPDATE, but that
--     trigger fires AFTER this one (Postgres BEFORE-row triggers run in
--     trigger-NAME order: `broadcasts_immutable_after_submit` <
--     `broadcasts_set_updated_at`), so `NEW.updated_at = OLD.updated_at`
--     when this function evaluates. Listing it as forbidden would be
--     harmless today but couples this guard to inter-trigger ordering;
--     leaving it unchecked lets the set_updated_at trigger own that column.
--
--     The `current_setting('app.allow_broadcast_redaction', true)` second arg
--     (`missing_ok = true`) returns NULL — not an error — when the GUC was
--     never SET in the session, so the normal lock path is unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION broadcasts_immutable_after_submit_fn()
RETURNS TRIGGER AS $$
DECLARE
  scheduled_for_changed boolean;
BEGIN
  IF OLD.status != 'draft' THEN
    -- GDPR Art.17 redaction exemption: when the erasure path sets
    -- `SET LOCAL app.allow_broadcast_redaction = 'on'`, ONLY the PII content
    -- columns the scrub writes (subject/body_html/body_source/from_name/
    -- reply_to_email/custom_recipient_emails/rejection_reason/
    -- cancellation_reason/failure_reason) MAY change. A change to ANY other
    -- immutable column (including the composite PK tenant_id/broadcast_id)
    -- still RAISEs `broadcast_redaction_only_pii_cols` (whitelist).
    IF current_setting('app.allow_broadcast_redaction', true) = 'on' THEN
      IF NEW.tenant_id                               IS DISTINCT FROM OLD.tenant_id
         OR NEW.broadcast_id                         IS DISTINCT FROM OLD.broadcast_id
         OR NEW.requested_by_member_id               IS DISTINCT FROM OLD.requested_by_member_id
         OR NEW.requested_by_member_plan_id_snapshot IS DISTINCT FROM OLD.requested_by_member_plan_id_snapshot
         OR NEW.submitted_by_user_id                 IS DISTINCT FROM OLD.submitted_by_user_id
         OR NEW.actor_role                           IS DISTINCT FROM OLD.actor_role
         OR NEW.segment_type                         IS DISTINCT FROM OLD.segment_type
         OR NEW.segment_params                       IS DISTINCT FROM OLD.segment_params
         OR NEW.estimated_recipient_count            IS DISTINCT FROM OLD.estimated_recipient_count
         OR NEW.status                               IS DISTINCT FROM OLD.status
         OR NEW.submitted_at                         IS DISTINCT FROM OLD.submitted_at
         OR NEW.approved_at                          IS DISTINCT FROM OLD.approved_at
         OR NEW.approved_by_user_id                  IS DISTINCT FROM OLD.approved_by_user_id
         OR NEW.rejected_at                          IS DISTINCT FROM OLD.rejected_at
         OR NEW.rejected_by_user_id                  IS DISTINCT FROM OLD.rejected_by_user_id
         OR NEW.scheduled_for                        IS DISTINCT FROM OLD.scheduled_for
         OR NEW.sending_started_at                   IS DISTINCT FROM OLD.sending_started_at
         OR NEW.sent_at                              IS DISTINCT FROM OLD.sent_at
         OR NEW.cancelled_at                         IS DISTINCT FROM OLD.cancelled_at
         OR NEW.cancelled_by_user_id                 IS DISTINCT FROM OLD.cancelled_by_user_id
         OR NEW.failed_to_dispatch_at                IS DISTINCT FROM OLD.failed_to_dispatch_at
         OR NEW.quota_year_consumed                  IS DISTINCT FROM OLD.quota_year_consumed
         OR NEW.quota_consumed_at                    IS DISTINCT FROM OLD.quota_consumed_at
         OR NEW.resend_audience_id                   IS DISTINCT FROM OLD.resend_audience_id
         OR NEW.resend_broadcast_id                  IS DISTINCT FROM OLD.resend_broadcast_id
         OR NEW.retention_years                      IS DISTINCT FROM OLD.retention_years
         OR NEW.manual_retry_count                   IS DISTINCT FROM OLD.manual_retry_count
         OR NEW.partial_delivery_accepted_at         IS DISTINCT FROM OLD.partial_delivery_accepted_at
         OR NEW.partial_delivery_accepted_by_user_id IS DISTINCT FROM OLD.partial_delivery_accepted_by_user_id
         OR NEW.started_from_template_id             IS DISTINCT FROM OLD.started_from_template_id
         OR NEW.template_name_snapshot               IS DISTINCT FROM OLD.template_name_snapshot
         OR NEW.created_at                           IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'broadcast_redaction_only_pii_cols'
          USING ERRCODE = 'check_violation',
                HINT    = 'Under app.allow_broadcast_redaction only subject/body_html/body_source/from_name/reply_to_email/custom_recipient_emails/rejection_reason/cancellation_reason/failure_reason may change.';
      END IF;
      RETURN NEW;
    END IF;

    scheduled_for_changed := NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for;
    -- During submit → approve, admin sets scheduled_for. Allowed.
    IF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      scheduled_for_changed := FALSE;
    END IF;

    IF NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_html IS DISTINCT FROM OLD.body_html
       OR NEW.body_source IS DISTINCT FROM OLD.body_source
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       OR scheduled_for_changed THEN
      RAISE EXCEPTION 'broadcast_immutable_after_submit'
        USING ERRCODE = 'check_violation',
              HINT    = 'Cancel and create a new draft to change content (FR-004 + Clarifications Q3).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- (2) Re-apply the 0124 search_path hardening — CREATE OR REPLACE above reset
--     the function config, so the hardening must be re-stamped or it regresses.
ALTER FUNCTION broadcasts_immutable_after_submit_fn() SET search_path = pg_catalog, public;--> statement-breakpoint
-- (3) New F7 audit event for the redaction action (`broadcast_content_redacted`).
--     Emitted by the broadcasts `scrubBroadcastContentForMember` use-case under
--     the erasure cascade. 5-year retention (F7 default — no tax-document
--     touchpoint). Registered in the shared pgEnum (auth schema) + the F7
--     audit-port union + the parity test.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_content_redacted';
