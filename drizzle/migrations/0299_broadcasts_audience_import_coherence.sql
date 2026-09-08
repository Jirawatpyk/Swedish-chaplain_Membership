-- 0299 — close two fail-open holes 0298 left, both found in 108 Phase 9 review
-- round 1 (reviews/review-20260908-223000.md S10 + S14).
--
-- ## 1. The coherence CHECK was an implication, not an iff
--
-- 0298 wrote three one-way clauses:
--
--     (id IS NOT NULL OR submitted_at IS NULL)        -- submitted_at -> id
--     (id IS NOT NULL OR completed_at IS NULL)        -- completed_at -> id
--     (completed_at IS NULL OR submitted_at IS NOT NULL)
--
-- Nothing forced the reverse, so `(id = 'imp_x', submitted_at = NULL)` PASSED.
-- That row is fail-open in two independent places at once:
--
--   * `build-audience-tick.ts` computed `ageMs = 0` for it, which is never
--     greater than the 30-minute threshold, so it polled Resend for ever;
--   * `broadcasts-gauges` filters on
--     `audience_import_submitted_at < now() - interval '30 minutes'`, and
--     `NULL < anything` is NULL, so the stuck gauge never counted it either.
--
-- A broadcast stuck with no alarm and no way out but by hand. The code half
-- now fails closed (`ageMs = Infinity`); this is the data half. 0298's own
-- comment said the CHECK was there to "keep a future writer honest" — it was
-- not honest in the one direction that costs anything.
--
-- The third clause below closes a smaller hole in the same family: nothing
-- stopped `completed_at` being EARLIER than `submitted_at`.
--
-- ## 2. 0224's redaction whitelist never got 0298's columns
--
-- `broadcasts_immutable_after_submit_fn()` has two arms. The non-GUC arm is a
-- blocklist naming seven content columns, so the import columns are writable on
-- an `approved` row — correct, and what the two-tick build needs.
--
-- The GUC arm is the opposite shape: under
-- `SET LOCAL app.allow_broadcast_redaction = 'on'` it enumerates every
-- FORBIDDEN column and RAISEs on any change to one. Anything not enumerated is
-- permitted by omission. So 0298's three columns — and `audience_deleted_at`,
-- missed the same way since 0229 — became silently mutable after submit under
-- the erasure GUC, contradicting 0224's own header ("the redaction path cannot
-- be abused to mutate audience targeting, the row identity, or the audit
-- trail"). `audience_import_id` sits closer to `resend_audience_id` (which IS
-- enumerated) than to any PII content column.
--
-- Not a live exploit: the only caller that sets the GUC is
-- `scrubContentForMemberInTx`, which names the columns it writes. But a
-- hand-maintained whitelist decays on every ALTER TABLE, and this is the second
-- decay. Closed while the file is open.
--
-- ## Safety
--
-- Both statements are idempotent and neither rewrites the table. Measured
-- 2026-09-09 before writing: dev has 0 rows violating the stricter predicate;
-- prod has **0 rows in `broadcasts` at all** and does not yet have 0298's
-- columns (0298 is unpushed, so both migrations land on the same deploy). The
-- `ADD CONSTRAINT ... CHECK` therefore validates under ACCESS EXCLUSIVE against
-- an empty table. Re-check `SELECT count(*) FROM broadcasts` before replaying
-- this on any tenant that has grown.
--
-- ROLLBACK: drop the constraint and re-run 0298's version; the function can be
-- replaced with the 0224 body. Nothing here is destructive and no data moves.

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_audience_import_coherent;
--> statement-breakpoint

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_audience_import_coherent CHECK (
    -- iff, not implication: an import id and its submit stamp are written by the
    -- same statement (`attachAudienceImport`) and must appear together.
    (audience_import_id IS NULL) = (audience_import_submitted_at IS NULL)
    -- A completion cannot exist without the submit it completes.
    AND (audience_import_completed_at IS NULL OR audience_import_submitted_at IS NOT NULL)
    -- Nor can it precede it.
    AND (
      audience_import_completed_at IS NULL
      OR audience_import_completed_at >= audience_import_submitted_at
    )
  );
--> statement-breakpoint

-- Reproduced from the LIVE definition (`pg_get_functiondef`, dev branch,
-- 2026-09-09) rather than reassembled from 0064/0075/0124/0224, so nothing an
-- intervening migration changed is silently reverted. The only edit is the four
-- added lines in the GUC arm, marked below.
--
-- `SET search_path` is declared inline: CREATE OR REPLACE resets a function's
-- config, and 0224 was bitten by exactly that (its own note at the foot of the
-- file). The ALTER after this statement is belt-and-braces, not a substitute.
CREATE OR REPLACE FUNCTION public.broadcasts_immutable_after_submit_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
         -- 0299 (108 Phase 9 review S14) — audience targeting and its provider
         -- handles are NOT PII content and must not be mutable under the
         -- redaction GUC. `audience_deleted_at` was missed the same way when
         -- 0229 added it.
         OR NEW.audience_import_id                   IS DISTINCT FROM OLD.audience_import_id
         OR NEW.audience_import_submitted_at         IS DISTINCT FROM OLD.audience_import_submitted_at
         OR NEW.audience_import_completed_at         IS DISTINCT FROM OLD.audience_import_completed_at
         OR NEW.audience_deleted_at                  IS DISTINCT FROM OLD.audience_deleted_at
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
$function$;
--> statement-breakpoint

ALTER FUNCTION broadcasts_immutable_after_submit_fn() SET search_path = pg_catalog, public;
