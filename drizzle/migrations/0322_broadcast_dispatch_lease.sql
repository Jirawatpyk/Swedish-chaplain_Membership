-- ---------------------------------------------------------------------------
-- Migration 0322 — spec 140 slice 2b: the import leg's per-row dispatch lease.
--
-- One cron invocation at a time works an `approved` E-Blast row (US2, DL1–DL4).
-- The dispatch cron's `maxDuration` (300 s) equals its cadence, and Vercel's
-- kill semantics are documented per invocation, so two ticks can overlap on
-- one row; nothing held a lock across the Resend calls (the row lock commits
-- before the first one). The import tick now CLAIMS the row (a fencing token +
-- an expiry, written in the step-1 lock tx), re-checks the lease before every
-- irreversible Resend call, carries the token in every write it makes, and
-- releases it at the end of the tick.
--
-- Numbered 0322, journal idx 323, `when` 1798545500000 — strictly after
-- 0321's 1798545400000 (a duplicate `when` makes db:migrate a silent no-op).
--
-- Column names: `dispatch_lease_token` / `dispatch_lease_expires_at`. The 2b
-- build plan's prose says `lease_token` / `lease_expires_at`; its SQL (Approach
-- items 2–4) says `dispatch_lease_*`, which also matches the sibling
-- `dispatch_first_failed_at` (0311). The SQL's names are the ones used.
--
-- Carries:
--   1. broadcasts.dispatch_lease_token uuid NULL and
--      broadcasts.dispatch_lease_expires_at timestamptz NULL, with CHECK
--      `broadcasts_dispatch_lease_pair` (both or neither): a token with no
--      expiry would never end, an expiry with no token is held by nobody.
--      Nullable, no default, no backfill — every existing row reads "not
--      leased", which is true. ADD COLUMN without a default is catalogue-only
--      (no table rewrite); the CHECK validates every row, and every row is
--      NULL/NULL, under the lock_timeout below.
--   2. broadcasts_immutable_after_submit_fn — the GUC arm's list gains both
--      lease columns, so the erasure scrub can neither take, move nor drop a
--      lease. Nothing else changes: reproduced from 0311 (the newest
--      definition, checked byte-identical to the live `prosrc` on the dev
--      branch on 1 Nov 2026). The dev body was applied from a CRLF checkout,
--      so its md5 44592cc4f81d94cc968a481533e89bc6 is of the CRLF text; the
--      same 0311 body with LF endings (as git stores it, and as a Linux
--      deploy applies it) has md5 f0df5871707b1d4629c99546a3ec53bb.
--
-- WHY THE TRIGGER IS TOUCHED (0311's header, the same reason): the normal arm
-- is a BLOCKLIST, so the claim, the release and a non-holder's clear (all on
-- an `approved` row or a status change out of it) need no exemption there.
-- The GUC arm is an explicit list of every non-PII column that must NOT move
-- under `app.allow_broadcast_redaction`; a column missing from it becomes
-- writable by the erasure scrub. Under the GUC the status cannot change
-- either, so a cancel's lease clear is never the scrub's write (A-b).
--
-- The other two triggers on `broadcasts` need nothing:
--   - broadcasts_state_machine (BEFORE UPDATE OF status) returns early when
--     the status is unchanged (the claim, the check and the release are
--     same-status writes) and reads no other column;
--   - broadcasts_set_updated_at bumps updated_at on every UPDATE, the claim
--     and the release included (twice per tick per row). The pre-call check
--     is a `SELECT … FOR UPDATE` and writes nothing.
--
-- Safe before the code that uses it: nothing reads or writes the columns until
-- slice 2b's code deploys, and the GUC-arm addition only refuses a write no
-- code makes. Unflagged on deploy (DDL is not flag-gated).
--
-- SEARCH-PATH HARDENING: CREATE OR REPLACE resets per-function config, so the
-- trailing `ALTER FUNCTION … SET search_path` is repeated (as 0299 / 0308 /
-- 0311).
--
-- Rollback: revert the code FIRST (the mapper selects the columns), then
-- `ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_dispatch_lease_pair,
-- DROP COLUMN dispatch_lease_token, DROP COLUMN dispatch_lease_expires_at;`
-- and re-apply 0311 § 2's function body.
-- ---------------------------------------------------------------------------

-- --- fail fast on the lock (0293 / 0305 / 0309 / 0310 / 0311 precedent) -----
-- `ADD COLUMN` takes ACCESS EXCLUSIVE on `broadcasts`. Prod migrates on deploy
-- while the app is live; abort after 5 s rather than queue every reader and
-- writer behind this statement. The batch rolls back whole, the deploy fails,
-- the previous deployment stays live, and a redeploy retries. The default is
-- handed back as this file's LAST statement.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- --- 1. the lease ------------------------------------------------------------

ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "dispatch_lease_token" uuid NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "dispatch_lease_expires_at" timestamptz NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'broadcasts_dispatch_lease_pair'
       AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_dispatch_lease_pair"
      CHECK ((dispatch_lease_token IS NULL) = (dispatch_lease_expires_at IS NULL));
  END IF;
END
$$;--> statement-breakpoint

-- --- 2. broadcasts_immutable_after_submit_fn amended -------------------------
-- Reproduced from 0311 § 2 with exactly ONE change: the GUC arm's list gains
-- `dispatch_lease_token` and `dispatch_lease_expires_at` (after 0311's
-- `dispatch_first_failed_at`). The normal arm, E1 / E2 / F1 and the RAISE texts
-- are byte-identical to 0311.
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
         -- 0322 (spec 140 s2b) — the dispatch lease. Not PII; the erasure
         -- scrub must never take, move or drop a tick's lease.
         OR NEW.dispatch_lease_token                 IS DISTINCT FROM OLD.dispatch_lease_token
         OR NEW.dispatch_lease_expires_at            IS DISTINCT FROM OLD.dispatch_lease_expires_at
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
