-- ---------------------------------------------------------------------------
-- Migration 0311 — F119 PR-E: the FR-021 dispatch retry budget counts from the
-- FIRST retryable failure of the current dispatch attempt, not from the row's
-- schedule.
--
-- The one-hour budget (`RETRY_BUDGET_MS`, both dispatch legs) used to measure
-- from `scheduled_for ?? approved_at ?? created_at`. Since #403 (a suspended
-- member's E-Blast is HELD at dispatch) and #410 (every cron pauses under
-- READ_ONLY_MODE), a row resuming more than an hour after `scheduled_for` is a
-- routine path — and on that path ONE retryable Resend error (429 / 5xx /
-- network) went straight to `retry_budget_exhausted`: the row failed for good,
-- the member was told the provider had been unreachable for over an hour
-- (false), and `dispatchBudgetExhausted` paged on-call.
--
-- Numbered 0311, journal idx 312, `when` 1798544400000 — strictly after
-- 0310's 1798544300000 (a duplicate `when` makes db:migrate a silent no-op).
--
-- Carries:
--   1. broadcasts.dispatch_first_failed_at timestamptz NULL — the budget
--      anchor. Stamped by the dispatcher on a retryable gateway failure with
--      `COALESCE(dispatch_first_failed_at, <now>)` and only while the row is
--      `approved` (BroadcastsRepo.markDispatchRetryStarted), so the first
--      failure of an attempt wins and a concurrent tick cannot move it. Reset
--      to NULL by `applyTransition` on every status change (and on a re-time),
--      so a re-approved or re-dispatched row starts clean. A HOLD (suspended
--      member) and a READ_ONLY_MODE skip never touch it — only a real gateway
--      failure starts the clock. Nullable, no default, no backfill: every
--      existing row reads "no failure yet", which is the truth the old epoch
--      could not tell. ADD COLUMN without a default is a catalogue-only change
--      (no table rewrite), under the lock_timeout below.
--   2. broadcasts_immutable_after_submit_fn — the GUC arm's blocklist gains
--      the new column. Nothing else changes (diffed against 0308 § 5).
--
-- WHY THE TRIGGER IS TOUCHED AT ALL. Its normal (non-GUC) arm is a BLOCKLIST
-- (content / segment_* / custom_recipient_emails / proposed_send_at /
-- scheduled_for), so a new column is already free to change after submit
-- there — the dispatcher's stamp and the transition's reset need no
-- exemption. The redaction-GUC arm is the opposite: an explicit list of every
-- non-PII column that must NOT move under `app.allow_broadcast_redaction`, and
-- a column missing from it becomes writable by the erasure scrub. 0299 and
-- 0308 each added their new columns to that list for exactly this reason
-- ("the erasure scrub must never move a row through the workflow"); 0311 does
-- the same, so the scrub can neither restart nor erase a row's retry clock.
--
-- The other two triggers on `broadcasts` need nothing:
--   - broadcasts_state_machine (BEFORE UPDATE OF status) returns early when
--     the status is unchanged — the stamp is a same-status UPDATE — and never
--     reads any other column;
--   - broadcasts_set_updated_at bumps updated_at on every UPDATE, the stamp
--     included (once per attempt: the dispatcher writes it only while it is
--     NULL).
--
-- SEARCH-PATH HARDENING: CREATE OR REPLACE resets per-function config, so the
-- trailing `ALTER FUNCTION … SET search_path` is repeated (as 0299 / 0308).
--
-- Rollback: `ALTER TABLE broadcasts DROP COLUMN dispatch_first_failed_at;`
-- and re-apply 0308 § 5's function body. The code that reads the column must
-- be reverted FIRST (the mapper selects it). Rows that failed under the old
-- epoch are not resurrected by either direction.
-- ---------------------------------------------------------------------------

-- --- fail fast on the lock (0293 / 0305 / 0309 / 0310 precedent) -----------
-- `ADD COLUMN` takes ACCESS EXCLUSIVE on `broadcasts`. Prod migrates on deploy
-- while the app is live: an open webhook or cron transaction that has read or
-- written the table holds a conflicting lock, and while this statement waits
-- in the lock queue every later reader and writer of `broadcasts` queues
-- behind it. The migrator sets only `statement_timeout` (30 s). Abort after
-- 5 s instead: the batch rolls back whole, the deploy fails, the previous
-- deployment stays live, and a redeploy retries. SET LOCAL lives to the end of
-- the migrator's single batch transaction, so the default is handed back as
-- this file's LAST statement — later migrations in the same deploy must not
-- inherit it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- --- 1. the budget anchor ----------------------------------------------------

ALTER TABLE "broadcasts" ADD COLUMN "dispatch_first_failed_at" timestamptz NULL;--> statement-breakpoint

-- --- 2. broadcasts_immutable_after_submit_fn amended -------------------------
-- Reproduced from 0308 § 5 with exactly ONE change: the GUC arm's blocklist
-- gains `dispatch_first_failed_at` (after the 0308 bookkeeping columns). The
-- normal arm, E1 / E2 / F1 and the RAISE texts are byte-identical to 0308.
CREATE OR REPLACE FUNCTION public.broadcasts_immutable_after_submit_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  content_changed boolean;
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
         -- 0308 (F119 FR-012a) — the approval round's bookkeeping. Not PII;
         -- the erasure scrub must never move a row through the workflow.
         OR NEW.proposed_send_at                     IS DISTINCT FROM OLD.proposed_send_at
         OR NEW.stage_entered_at                     IS DISTINCT FROM OLD.stage_entered_at
         OR NEW.current_round                        IS DISTINCT FROM OLD.current_round
         OR NEW.approved_version_id                  IS DISTINCT FROM OLD.approved_version_id
         OR NEW.member_reminder_stage                IS DISTINCT FROM OLD.member_reminder_stage
         OR NEW.member_expiry_notified_at            IS DISTINCT FROM OLD.member_expiry_notified_at
         -- 0311 (F119 PR-E) — the FR-021 retry-budget anchor. Not PII; the
         -- erasure scrub must never restart or erase a row's retry clock.
         OR NEW.dispatch_first_failed_at             IS DISTINCT FROM OLD.dispatch_first_failed_at
         OR NEW.created_at                           IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'broadcast_redaction_only_pii_cols'
          USING ERRCODE = 'check_violation',
                HINT    = 'Under app.allow_broadcast_redaction only subject/body_html/body_source/from_name/reply_to_email/custom_recipient_emails/rejection_reason/cancellation_reason/failure_reason may change.';
      END IF;
      RETURN NEW;
    END IF;

    content_changed := NEW.subject IS DISTINCT FROM OLD.subject
                       OR NEW.body_html IS DISTINCT FROM OLD.body_html
                       OR NEW.body_source IS DISTINCT FROM OLD.body_source;
    -- 0308 E1 — the promotion of the member-approved version.
    IF OLD.status = 'member_approved' AND NEW.status = 'approved' THEN
      content_changed := FALSE;
    END IF;

    scheduled_for_changed := NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for;
    -- During submit → approve, admin sets scheduled_for. Allowed.
    IF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      scheduled_for_changed := FALSE;
    END IF;
    -- 0308 E2 — confirm, change, or cancel the time (on a withdrawal or a
    -- voiding edit).
    IF OLD.status IN ('member_approved', 'approved')
       AND NEW.status IN ('approved', 'changes_requested', 'in_design') THEN
      scheduled_for_changed := FALSE;
    END IF;

    IF content_changed
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       -- 0308 F1 — the member's proposal is frozen after draft.
       OR NEW.proposed_send_at IS DISTINCT FROM OLD.proposed_send_at
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

ALTER FUNCTION broadcasts_immutable_after_submit_fn() SET search_path = pg_catalog, public;--> statement-breakpoint

-- Hand the default back (see the lock_timeout block above).
SET LOCAL lock_timeout = DEFAULT;
