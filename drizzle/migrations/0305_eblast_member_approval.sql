-- ---------------------------------------------------------------------------
-- Migration 0305 — F119 E-Blast two-sided approval (PR-2). THE FR-012a
-- BUNDLE: the new stages, the tables they need and both trigger amendments
-- ship in ONE migration, so no deploy can carry a stage the triggers refuse
-- or a trigger exemption for a stage that does not exist.
-- specs/119-eblast-approval-workflow/data-model.md §§ 1, 2, 3, 5, 7, 8.2, 8.3;
-- research R2, R5, R8, R17, R24.
--
-- Carries:
--   - broadcast_status  += 5   in_design, awaiting_member_approval,
--                              changes_requested, member_approved,
--                              expired_no_member_response (TERMINAL)
--   - notification_type += 5   the eblast_* outbox rows (the drainer skips
--                              them while FEATURE_EBLAST_MEMBER_APPROVAL is off)
--   - audit_event_type  += 10  the workflow events (5-year retention)
--   - broadcast_versions            (+ RLS/FORCE, immutable-after-send trigger)
--   - broadcast_member_decisions    (+ RLS/FORCE, append-only trigger)
--   - broadcasts +6 columns         proposed_send_at, stage_entered_at,
--                                   current_round, approved_version_id,
--                                   member_reminder_stage,
--                                   member_expiry_notified_at (+ 3 indexes)
--   - two backfills, then broadcasts_immutable_after_submit_fn amended
--     (E1, E2, F1 + the six new columns forbidden under the redaction GUC)
--   - broadcasts_state_machine_fn amended with the § 8.2 arms
--
-- The twenty ADD VALUE lines sit at the top, one per line, each ending in
-- `;`: scripts/run-migrations.ts extracts every `ALTER TYPE … ADD VALUE`
-- across the migration files and replays it in AUTOCOMMIT BEFORE the
-- transactional pass (scripts/lib/enum-migration-guard.ts, the 0230
-- incident). That is what lets this same file create a partial index on
-- `status = 'awaiting_member_approval'` — the value is already committed —
-- and the transactional copy below is an `IF NOT EXISTS` no-op.
--
-- STATEMENT ORDER FOR `broadcasts` IS NORMATIVE (data-model § 3, round 3 H5 +
-- round 4 L3): (1) ADD COLUMN ×6, (2) the two backfills, (3) CREATE OR REPLACE
-- of broadcasts_immutable_after_submit_fn. Backfill 1 writes
-- proposed_send_at, which does not exist before (1); F1 freezes
-- proposed_send_at in a BEFORE UPDATE trigger, so replacing the function
-- before (2) would make backfill 1 raise broadcast_immutable_after_submit and
-- abort the migration.
--
-- The backfills are bracketed by DISABLE / ENABLE of broadcasts_set_updated_at
-- (a BEFORE UPDATE trigger that stamps `updated_at := now()`). Without it both
-- UPDATEs would reset `updated_at` on every row they touch — backfill 2 touches
-- essentially all of them — and `prune-expired-drafts` deletes drafts on
-- `updated_at < now() - 30 days`, so every stale draft would get a fresh
-- 30-day lease on deploy and every "last updated" read would jump. Both ALTERs
-- run inside the migration transaction (the ADD COLUMN above already holds
-- ACCESS EXCLUSIVE on broadcasts), so no other session ever observes the
-- trigger disabled. This bracket is not in data-model § 3; the two backfill
-- statements themselves are verbatim.
--
-- GRANTs: data-model §§ 1–2 name none. chamber_app gets SELECT, INSERT,
-- UPDATE on both tables and NO DELETE: versions leave only by the CASCADE
-- from their E-Blast (RI actions run as the table owner, not chamber_app),
-- and decisions are append-only (UPDATE is granted for the erasure GUC's
-- reason-only redaction; the trigger refuses everything else).
--
-- NOTE on the decisions DELETE trigger: a Postgres ON DELETE CASCADE runs a
-- DELETE on the child rows that DOES fire the child's row-level BEFORE DELETE
-- trigger (measured on dev). The contract's intent is that the cascade from
-- the parent is allowed and a direct DELETE is not, so the DELETE arm lets
-- the row go only when `pg_trigger_depth() > 1` — i.e. the DELETE was issued
-- from inside the RI cascade trigger of `broadcasts` / `broadcast_versions`
-- — and raises at depth 1, a DELETE issued directly against the table
-- (both sides measured on dev, pinned by eblast-immutability-trigger.test.ts).
-- Residual: a DELETE issued from inside some OTHER trigger would also pass;
-- none exists, and chamber_app holds no DELETE grant on the table.
--
-- Rollback (quickstart § 3.5): the enum values are irreversible. DROP TABLE
-- broadcast_member_decisions, broadcast_versions (after clearing
-- broadcasts.approved_version_id); ALTER TABLE broadcasts DROP the six
-- columns; replace both functions with the 0299 / 0217 bodies. Rows already
-- in a new status must be cancelled first, or the old state machine refuses
-- every write to them.
-- ---------------------------------------------------------------------------

-- --- 0. enum values (hoisted to AUTOCOMMIT by the runner) -------------------

ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'in_design';--> statement-breakpoint
ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'awaiting_member_approval';--> statement-breakpoint
ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'changes_requested';--> statement-breakpoint
ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'member_approved';--> statement-breakpoint
ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'expired_no_member_response';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'eblast_submitted_marketing';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'eblast_member_decided_marketing';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'eblast_version_sent_member';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'eblast_schedule_confirmed_member';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'eblast_approval_lifecycle';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_version_started';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_version_sent_to_member';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_member_approved';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_member_changes_requested';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_member_approval_withdrawn';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_member_approval_voided';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_schedule_confirmed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_approval_reminder_sent';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_approval_expiry_warned';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_approval_expired';--> statement-breakpoint

-- --- 1. broadcast_versions (data-model § 1) ---------------------------------
-- version_no 0 = the member's original (materialised lazily when marketing
-- first formats); 1..n = marketing's versions. sent_to_member_at NULL = the
-- working copy; set ⇒ read-only (FR-003). No brand snapshot, by decision
-- (FR-041c): chrome is applied live at render time.

CREATE TABLE "broadcast_versions" (
  "tenant_id"            text                 NOT NULL,
  "id"                   uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "broadcast_id"         uuid                 NOT NULL,
  "version_no"           smallint             NOT NULL
                           CONSTRAINT "broadcast_versions_version_no_check"
                           CHECK ("version_no" >= 0),
  "subject"              text                 NOT NULL
                           CONSTRAINT "broadcast_versions_subject_length"
                           CHECK (char_length("subject") BETWEEN 1 AND 200),
  "body_html"            text                 NOT NULL
                           CONSTRAINT "broadcast_versions_body_html_size"
                           CHECK (octet_length("body_html") BETWEEN 1 AND 200 * 1024),
  "body_source"          text                 NOT NULL,
  "note_to_member"       text                 NULL
                           CONSTRAINT "broadcast_versions_note_to_member_length"
                           CHECK ("note_to_member" IS NULL OR char_length("note_to_member") <= 1000),
  "authored_by_user_id"  uuid                 NOT NULL,
  "authored_by_role"     broadcast_actor_role NOT NULL,
  "sent_to_member_at"    timestamptz          NULL,
  "created_at"           timestamptz          NOT NULL DEFAULT now(),
  "updated_at"           timestamptz          NOT NULL DEFAULT now(),
  CONSTRAINT "broadcast_versions_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "broadcast_versions_broadcast_fk"
    FOREIGN KEY ("tenant_id", "broadcast_id")
    REFERENCES "broadcasts" ("tenant_id", "broadcast_id") ON DELETE CASCADE
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "broadcast_versions" TO chamber_app;--> statement-breakpoint

CREATE UNIQUE INDEX "broadcast_versions_broadcast_version_no_uniq"
  ON "broadcast_versions" ("tenant_id", "broadcast_id", "version_no");--> statement-breakpoint
-- At most one working copy per E-Blast.
CREATE UNIQUE INDEX "broadcast_versions_one_unsent_idx"
  ON "broadcast_versions" ("tenant_id", "broadcast_id")
  WHERE "sent_to_member_at" IS NULL;--> statement-breakpoint
-- The history thread.
CREATE INDEX "broadcast_versions_history_idx"
  ON "broadcast_versions" ("tenant_id", "broadcast_id", "version_no" DESC);--> statement-breakpoint
-- FK-column index (the 0302 lesson).
CREATE INDEX "broadcast_versions_tenant_broadcast_idx"
  ON "broadcast_versions" ("tenant_id", "broadcast_id");--> statement-breakpoint

-- Read-only once sent. Under the erasure GUC only the four content columns
-- (subject, body_html, body_source, note_to_member) may change — every other
-- column this trigger guards is enumerated as forbidden (whitelist by
-- omission, the 0299 shape). `updated_at` is the only column left writable
-- in both arms.
CREATE OR REPLACE FUNCTION broadcast_versions_immutable_after_send_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.sent_to_member_at IS NULL THEN
    RETURN NEW;  -- the working copy is editable
  END IF;

  IF current_setting('app.allow_broadcast_redaction', true) = 'on' THEN
    IF NEW.tenant_id                IS DISTINCT FROM OLD.tenant_id
       OR NEW.id                    IS DISTINCT FROM OLD.id
       OR NEW.broadcast_id          IS DISTINCT FROM OLD.broadcast_id
       OR NEW.version_no            IS DISTINCT FROM OLD.version_no
       OR NEW.authored_by_user_id   IS DISTINCT FROM OLD.authored_by_user_id
       OR NEW.authored_by_role      IS DISTINCT FROM OLD.authored_by_role
       OR NEW.sent_to_member_at     IS DISTINCT FROM OLD.sent_to_member_at
       OR NEW.created_at            IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'broadcast_version_immutable_after_send'
        USING ERRCODE = 'check_violation',
              HINT    = 'Under app.allow_broadcast_redaction only subject/body_html/body_source/note_to_member may change.';
    END IF;
    RETURN NEW;
  END IF;

  -- Every column but `updated_at` (the optimistic-concurrency token) is
  -- frozen once sent: the seven data-model § 1 names, plus the row identity
  -- and `authored_by_role` (audit-truth — the role the author actually held).
  IF NEW.subject                IS DISTINCT FROM OLD.subject
     OR NEW.body_html           IS DISTINCT FROM OLD.body_html
     OR NEW.body_source         IS DISTINCT FROM OLD.body_source
     OR NEW.note_to_member      IS DISTINCT FROM OLD.note_to_member
     OR NEW.version_no          IS DISTINCT FROM OLD.version_no
     OR NEW.authored_by_user_id IS DISTINCT FROM OLD.authored_by_user_id
     OR NEW.sent_to_member_at   IS DISTINCT FROM OLD.sent_to_member_at
     OR NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id
     OR NEW.id                  IS DISTINCT FROM OLD.id
     OR NEW.broadcast_id        IS DISTINCT FROM OLD.broadcast_id
     OR NEW.authored_by_role    IS DISTINCT FROM OLD.authored_by_role
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'broadcast_version_immutable_after_send'
      USING ERRCODE = 'check_violation',
            HINT    = 'A version sent to the member is read-only (FR-003); start a new version instead.';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER broadcast_versions_immutable_after_send
  BEFORE UPDATE ON broadcast_versions
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_versions_immutable_after_send_fn();--> statement-breakpoint

ALTER TABLE "broadcast_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_versions" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_versions"
  ON "broadcast_versions"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 2. broadcast_member_decisions (data-model § 2) -------------------------
-- Append-only, one row per member action on one version. NO FK on either
-- actor column, by decision: users is cross-tenant (a composite FK from a
-- tenant-scoped table cannot reach it), and the contact is left unconstrained
-- so SC-002's proof of who approved survives the contact's removal. Do not
-- "fix" this into a cascade that would delete the proof.

CREATE TABLE "broadcast_member_decisions" (
  "tenant_id"              text        NOT NULL,
  "id"                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  "broadcast_id"           uuid        NOT NULL,
  "version_id"             uuid        NOT NULL,
  "round"                  smallint    NOT NULL
                             CONSTRAINT "broadcast_member_decisions_round_check"
                             CHECK ("round" >= 1),
  "decision"               text        NOT NULL
                             CONSTRAINT "broadcast_member_decisions_decision_check"
                             CHECK ("decision" IN ('approved', 'changes_requested', 'approval_withdrawn')),
  "reason"                 text        NULL,
  "decided_by_user_id"     uuid        NOT NULL,
  "decided_by_contact_id"  uuid        NOT NULL,
  "decided_at"             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "broadcast_member_decisions_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "broadcast_member_decisions_broadcast_fk"
    FOREIGN KEY ("tenant_id", "broadcast_id")
    REFERENCES "broadcasts" ("tenant_id", "broadcast_id") ON DELETE CASCADE,
  CONSTRAINT "broadcast_member_decisions_version_fk"
    FOREIGN KEY ("tenant_id", "version_id")
    REFERENCES "broadcast_versions" ("tenant_id", "id") ON DELETE CASCADE,
  -- FR-009 (optional approval note ≤ 500) + FR-010 / FR-015a (required
  -- reason 1–2,000) in ONE check, both bounds.
  CONSTRAINT "broadcast_member_decisions_reason_check"
    CHECK (
      ("decision" = 'approved' AND ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500))
      OR ("decision" <> 'approved' AND "reason" IS NOT NULL AND char_length("reason") BETWEEN 1 AND 2000)
    )
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "broadcast_member_decisions" TO chamber_app;--> statement-breakpoint

-- The thread.
CREATE INDEX "broadcast_member_decisions_thread_idx"
  ON "broadcast_member_decisions" ("tenant_id", "broadcast_id", "decided_at" DESC);--> statement-breakpoint
-- FK-column index (the 0302 lesson).
CREATE INDEX "broadcast_member_decisions_version_idx"
  ON "broadcast_member_decisions" ("tenant_id", "version_id");--> statement-breakpoint
-- "Which contact approved this" — a DSAR / audit-review lookup; the 0302
-- lesson applies even with no constraint behind it.
CREATE INDEX "broadcast_member_decisions_contact_idx"
  ON "broadcast_member_decisions" ("tenant_id", "decided_by_contact_id");--> statement-breakpoint

-- UPDATE is refused except a reason-only change under the erasure GUC;
-- DELETE is refused unless it arrives through the parent's ON DELETE CASCADE
-- (see the header note).
CREATE OR REPLACE FUNCTION broadcast_member_decisions_append_only_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Depth 1 = a DELETE issued directly against this table → refused.
  -- Depth > 1 = issued from inside another trigger, here the RI cascade of
  -- broadcasts / broadcast_versions → the decision leaves with its E-Blast.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND current_setting('app.allow_broadcast_redaction', true) = 'on'
     AND NEW.tenant_id              IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.id                     IS NOT DISTINCT FROM OLD.id
     AND NEW.broadcast_id           IS NOT DISTINCT FROM OLD.broadcast_id
     AND NEW.version_id             IS NOT DISTINCT FROM OLD.version_id
     AND NEW.round                  IS NOT DISTINCT FROM OLD.round
     AND NEW.decision               IS NOT DISTINCT FROM OLD.decision
     AND NEW.decided_by_user_id     IS NOT DISTINCT FROM OLD.decided_by_user_id
     AND NEW.decided_by_contact_id  IS NOT DISTINCT FROM OLD.decided_by_contact_id
     AND NEW.decided_at             IS NOT DISTINCT FROM OLD.decided_at THEN
    RETURN NEW;  -- GDPR Art.17: only `reason` is redacted, the row is kept
  END IF;
  RAISE EXCEPTION 'broadcast_decision_append_only'
    USING ERRCODE = 'check_violation',
          HINT    = 'broadcast_member_decisions rows are append-only (SC-002 proof).';
END;
$$;--> statement-breakpoint

CREATE TRIGGER broadcast_member_decisions_no_update
  BEFORE UPDATE ON broadcast_member_decisions
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_member_decisions_append_only_fn();--> statement-breakpoint

CREATE TRIGGER broadcast_member_decisions_no_delete
  BEFORE DELETE ON broadcast_member_decisions
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_member_decisions_append_only_fn();--> statement-breakpoint

ALTER TABLE "broadcast_member_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_member_decisions" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_member_decisions"
  ON "broadcast_member_decisions"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 3. broadcasts +6 columns (data-model § 3) — STEP (1) of the normative order

ALTER TABLE "broadcasts"
  ADD COLUMN "proposed_send_at" timestamptz NULL,
  ADD COLUMN "stage_entered_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN "current_round" smallint NOT NULL DEFAULT 0,
  ADD COLUMN "approved_version_id" uuid NULL,
  ADD COLUMN "member_reminder_stage" smallint NOT NULL DEFAULT 0
    CONSTRAINT "broadcasts_member_reminder_stage_check"
    CHECK ("member_reminder_stage" BETWEEN 0 AND 3),
  ADD COLUMN "member_expiry_notified_at" timestamptz NULL,
  ADD CONSTRAINT "broadcasts_approved_version_fk"
    FOREIGN KEY ("tenant_id", "approved_version_id")
    REFERENCES "broadcast_versions" ("tenant_id", "id");--> statement-breakpoint

-- The dashboard's per-stage list + the stalled comparison at 1,000 rows (SC-008).
CREATE INDEX "broadcasts_stage_queue_idx"
  ON "broadcasts" ("tenant_id", "status", "stage_entered_at" DESC);--> statement-breakpoint
-- The daily reminder / expiry scan and the oldest-age gauge.
CREATE INDEX "broadcasts_awaiting_member_idx"
  ON "broadcasts" ("tenant_id", "stage_entered_at")
  WHERE "status" = 'awaiting_member_approval';--> statement-breakpoint
-- FK-column index.
CREATE INDEX "broadcasts_approved_version_idx"
  ON "broadcasts" ("tenant_id", "approved_version_id");--> statement-breakpoint

-- --- 4. backfills — STEP (2); MUST precede the function replacement ---------

ALTER TABLE "broadcasts" DISABLE TRIGGER "broadcasts_set_updated_at";--> statement-breakpoint

-- (1) Only rows still awaiting a decision carry an untouched proposal
-- (approveBroadcast overwrites scheduled_for). Every other historical row
-- keeps NULL and the UI shows "not recorded".
UPDATE broadcasts SET proposed_send_at = scheduled_for WHERE status = 'submitted' AND scheduled_for IS NOT NULL;--> statement-breakpoint

-- (2) Without it the column's DEFAULT now() would make every pre-existing
-- waiting row look freshly entered and reset the live 24 h / 48 h SLA badges
-- on deploy (round 3 M3).
UPDATE broadcasts SET stage_entered_at = COALESCE(submitted_at, updated_at) WHERE stage_entered_at IS DISTINCT FROM COALESCE(submitted_at, updated_at);--> statement-breakpoint

ALTER TABLE "broadcasts" ENABLE TRIGGER "broadcasts_set_updated_at";--> statement-breakpoint

-- --- 5. broadcasts_immutable_after_submit_fn amended — STEP (3) -------------
-- Reproduced from the LIVE definition (`pg_get_functiondef`, dev branch,
-- 2026-09-23 — identical to 0299) with exactly three changes (data-model
-- § 8.3) plus the GUC arm extension:
--   E1  member_approved → approved releases subject / body_html / body_source
--       (the PROMOTION of the approved version, FR-012a a). The content test
--       is split out of the old single IF so E1 can clear it WITHOUT also
--       releasing the audience columns.
--   E2  member_approved|approved → approved|changes_requested|in_design
--       releases scheduled_for (confirm, change, cancel on withdrawal or a
--       voiding edit — FR-012a b). `approved → approved` is a reschedule and
--       is admitted by design. The submitted → approved exemption is verbatim.
--   F1  proposed_send_at joins the frozen set (FR-016).
--   segment_type / segment_params / custom_recipient_emails stay frozen on
--   EVERY transition, the exempt edges included (FR-005).
--   GUC arm: the six new columns are forbidden, so the erasure scrub cannot
--   move a row through the workflow.
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
         -- 0305 (F119 FR-012a) — the approval round's bookkeeping. Not PII;
         -- the erasure scrub must never move a row through the workflow.
         OR NEW.proposed_send_at                     IS DISTINCT FROM OLD.proposed_send_at
         OR NEW.stage_entered_at                     IS DISTINCT FROM OLD.stage_entered_at
         OR NEW.current_round                        IS DISTINCT FROM OLD.current_round
         OR NEW.approved_version_id                  IS DISTINCT FROM OLD.approved_version_id
         OR NEW.member_reminder_stage                IS DISTINCT FROM OLD.member_reminder_stage
         OR NEW.member_expiry_notified_at            IS DISTINCT FROM OLD.member_expiry_notified_at
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
    -- 0305 E1 — the promotion of the member-approved version.
    IF OLD.status = 'member_approved' AND NEW.status = 'approved' THEN
      content_changed := FALSE;
    END IF;

    scheduled_for_changed := NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for;
    -- During submit → approve, admin sets scheduled_for. Allowed.
    IF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      scheduled_for_changed := FALSE;
    END IF;
    -- 0305 E2 — confirm, change, or cancel the time (on a withdrawal or a
    -- voiding edit).
    IF OLD.status IN ('member_approved', 'approved')
       AND NEW.status IN ('approved', 'changes_requested', 'in_design') THEN
      scheduled_for_changed := FALSE;
    END IF;

    IF content_changed
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       -- 0305 F1 — the member's proposal is frozen after draft.
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

-- --- 6. broadcasts_state_machine_fn amended (data-model § 8.2) --------------
-- Reproduced from the LIVE definition (identical to 0217) with the new and
-- changed arms. The ELSE → empty targets fail-closed default is kept.
-- Application guards on top (not the DB's job): approved → in_design |
-- changes_requested need current_round >= 1; submitted → in_design is the
-- only flag-gated edge. The three pre-existing Domain ↔ DB divergences
-- (draft → cancelled, approved → failed_to_dispatch, sending → cancelled)
-- are recorded in plan.md R-7 and deliberately left as they are.
CREATE OR REPLACE FUNCTION broadcasts_state_machine_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed_targets text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;  -- no transition; non-status updates allowed
  END IF;

  CASE OLD.status
    WHEN 'draft'                      THEN allowed_targets := ARRAY['submitted', 'cancelled'];
    -- 0305: + in_design (start a formatted version; flag-gated in Application).
    WHEN 'submitted'                  THEN allowed_targets := ARRAY['approved', 'rejected', 'cancelled', 'in_design'];
    -- 0305: + changes_requested (withdrawn approval / cancelled time) and
    -- in_design (marketing edits after a round) — both need round >= 1.
    WHEN 'approved'                   THEN allowed_targets := ARRAY['sending', 'cancelled', 'failed_to_dispatch', 'changes_requested', 'in_design'];
    -- F7.1a US1: a batched send may progress to partially_sent (FR-008a) or
    -- be cancelled mid-dispatch (FR-004a hasBatches path) in addition to the
    -- F7-MVP sent / failed_to_dispatch edges.
    WHEN 'sending'                    THEN allowed_targets := ARRAY['sent', 'failed_to_dispatch', 'cancelled', 'partially_sent'];
    -- F7.1a US1: partially_sent is NON-terminal — admin retry (-> sending,
    -- FR-008b) or accept-partial (-> partial_delivery_accepted, FR-008c).
    WHEN 'partially_sent'             THEN allowed_targets := ARRAY['sending', 'partial_delivery_accepted'];
    -- 0305 (F119) — the approval round.
    WHEN 'in_design'                  THEN allowed_targets := ARRAY['awaiting_member_approval', 'rejected', 'cancelled'];
    WHEN 'awaiting_member_approval'   THEN allowed_targets := ARRAY['member_approved', 'changes_requested', 'rejected', 'cancelled', 'expired_no_member_response'];
    WHEN 'changes_requested'          THEN allowed_targets := ARRAY['in_design', 'rejected', 'cancelled'];
    WHEN 'member_approved'            THEN allowed_targets := ARRAY['approved', 'changes_requested', 'in_design', 'rejected', 'cancelled'];
    WHEN 'sent'                       THEN allowed_targets := ARRAY[]::text[];
    WHEN 'rejected'                   THEN allowed_targets := ARRAY[]::text[];
    WHEN 'cancelled'                  THEN allowed_targets := ARRAY[]::text[];
    WHEN 'failed_to_dispatch'         THEN allowed_targets := ARRAY[]::text[];
    WHEN 'partial_delivery_accepted'  THEN allowed_targets := ARRAY[]::text[];  -- TERMINAL
    -- 0305: TERMINAL — no closed stage can be reopened (FR-022a).
    WHEN 'expired_no_member_response' THEN allowed_targets := ARRAY[]::text[];
    ELSE
      -- Defensive: any future enum value reaching an UPDATE without a
      -- matching arm has no legal outbound transition (raises
      -- invalid_transition below) rather than aborting with the opaque
      -- CASE_NOT_FOUND (20000) the original arm-less body threw.
      allowed_targets := ARRAY[]::text[];
  END CASE;

  IF NOT (NEW.status::text = ANY (allowed_targets)) THEN
    RAISE EXCEPTION 'broadcast_invalid_state_transition'
      USING ERRCODE = 'check_violation',
            DETAIL  = format('cannot transition broadcast from %s to %s', OLD.status, NEW.status),
            HINT    = 'See FR-004 + FR-004a + FR-008 + F119 data-model § 8.2 state machine.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

ALTER FUNCTION broadcasts_state_machine_fn() SET search_path = pg_catalog, public;
