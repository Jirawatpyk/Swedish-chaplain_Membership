-- ---------------------------------------------------------------------------
-- F7 — broadcasts table (T011 per specs/010-email-broadcast/tasks.md).
--
-- One row per E-Blast request across its full lifecycle. Stores both
-- member-self-service and admin-proxy submissions per Q12 dual-actor.
-- Composite PK (tenant_id, broadcast_id) matches F3+F4 convention.
--
-- Source of truth: specs/010-email-broadcast/data-model.md § 1.1 + § 2 + § 4.
--
-- This migration also defines 3 of the 5 F7 enums used here:
--   - broadcast_status (8 lifecycle states per FR-004)
--   - broadcast_segment_type (4 targeting types per FR-015)
--   - broadcast_actor_role (3 origins per Q12 dual-actor + N1 'system')
--
-- Note on T018a (the originally-planned 0072 ALTER TYPE migration):
-- the 'system' enum value is included from the start in the CREATE TYPE
-- below — no separate ALTER TYPE migration needed. The 0072 file is
-- intentionally absent. Documented as a deviation in plan.md
-- § Complexity Tracking.
--
-- This migration also installs 3 PL/pgSQL triggers on the broadcasts
-- table (defence-in-depth pairing with Domain-layer policies):
--   - broadcasts_immutable_after_submit (Clarifications Q3 + FR-004)
--   - broadcasts_state_machine          (FR-004 + FR-004a)
--   - broadcasts_set_updated_at         (standard updated_at touch)
-- ---------------------------------------------------------------------------

-- --- 1. Enums ---------------------------------------------------------------

CREATE TYPE "broadcast_status" AS ENUM (
  'draft',
  'submitted',
  'approved',
  'sending',
  'sent',
  'rejected',
  'cancelled',
  'failed_to_dispatch'
);--> statement-breakpoint

CREATE TYPE "broadcast_segment_type" AS ENUM (
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom'
);--> statement-breakpoint

CREATE TYPE "broadcast_actor_role" AS ENUM (
  'member_self_service',
  'admin_proxy',
  'system'
);--> statement-breakpoint

-- --- 2. broadcasts table ----------------------------------------------------

CREATE TABLE "broadcasts" (
  "tenant_id"                              text NOT NULL,
  "broadcast_id"                           uuid NOT NULL DEFAULT gen_random_uuid(),

  -- Originator (FR-005 + Q12 dual-actor)
  "requested_by_member_id"                 uuid NOT NULL,
  "requested_by_member_plan_id_snapshot"   uuid NOT NULL,
  "submitted_by_user_id"                   uuid NOT NULL,
  "actor_role"                             "broadcast_actor_role" NOT NULL,

  -- Content (Q3 immutable after submit; Q4 sanitised at Application layer)
  "subject"                                text NOT NULL,
  "body_html"                              text NOT NULL,
  "body_source"                            text NOT NULL,
  "from_name"                              text NOT NULL,
  "reply_to_email"                         text NOT NULL,

  -- Recipient targeting (FR-015 / FR-016a / FR-017 + Q7 + Q8)
  "segment_type"                           "broadcast_segment_type" NOT NULL,
  "segment_params"                         jsonb,
  "custom_recipient_emails"                text[],
  "estimated_recipient_count"              integer NOT NULL,

  -- Lifecycle (FR-004 + FR-004a)
  "status"                                 "broadcast_status" NOT NULL DEFAULT 'draft',
  "submitted_at"                           timestamp with time zone,
  "approved_at"                            timestamp with time zone,
  "approved_by_user_id"                    uuid,
  "rejected_at"                            timestamp with time zone,
  "rejected_by_user_id"                    uuid,
  "rejection_reason"                       text,
  "scheduled_for"                          timestamp with time zone,
  "sending_started_at"                     timestamp with time zone,
  "sent_at"                                timestamp with time zone,
  "cancelled_at"                           timestamp with time zone,
  "cancelled_by_user_id"                   uuid,
  "cancellation_reason"                    text,
  "failed_to_dispatch_at"                  timestamp with time zone,
  "failure_reason"                         text,

  -- Quota accounting (FR-003 + FR-006 + FR-007)
  "quota_year_consumed"                    integer,
  "quota_consumed_at"                      timestamp with time zone,

  -- Resend integration
  "resend_audience_id"                     text,
  "resend_broadcast_id"                    text,

  -- Audit retention (Constitution v1.4.0)
  "retention_years"                        smallint NOT NULL DEFAULT 5,

  "created_at"                             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                             timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("tenant_id", "broadcast_id"),

  -- FR-002f: subject ≤ 200 chars
  CONSTRAINT "broadcasts_subject_length"
    CHECK (char_length("subject") BETWEEN 1 AND 200),

  -- FR-002f: body ≤ 200 KB rendered HTML (octet_length is byte count)
  CONSTRAINT "broadcasts_body_html_size"
    CHECK (octet_length("body_html") BETWEEN 1 AND 200 * 1024),

  -- FR-016a: custom recipient cap at row level
  CONSTRAINT "broadcasts_custom_recipient_cap"
    CHECK (
      ("segment_type" != 'custom' AND "custom_recipient_emails" IS NULL)
      OR ("segment_type" = 'custom' AND array_length("custom_recipient_emails", 1) BETWEEN 1 AND 100)
    ),

  -- FR-016a: estimated_recipient_count ≤ 5000
  CONSTRAINT "broadcasts_estimated_recipient_cap"
    CHECK ("estimated_recipient_count" BETWEEN 0 AND 5000),

  -- FR-007: quota_year_consumed only set on `sent`
  CONSTRAINT "broadcasts_quota_year_only_on_sent"
    CHECK (
      ("status" = 'sent' AND "quota_year_consumed" IS NOT NULL AND "quota_consumed_at" IS NOT NULL)
      OR ("status" != 'sent' AND "quota_year_consumed" IS NULL AND "quota_consumed_at" IS NULL)
    ),

  -- Constitution v1.4.0: retention default 5y for non-tax-document events
  CONSTRAINT "broadcasts_retention_years"
    CHECK ("retention_years" IN (5, 10))
);--> statement-breakpoint

-- --- 3. Indexes -------------------------------------------------------------

CREATE INDEX "broadcasts_tenant_status_member_idx"
  ON "broadcasts" ("tenant_id", "status", "requested_by_member_id");--> statement-breakpoint

CREATE INDEX "broadcasts_tenant_submitted_at_idx"
  ON "broadcasts" ("tenant_id", "submitted_at" DESC)
  WHERE "status" = 'submitted';--> statement-breakpoint

CREATE INDEX "broadcasts_tenant_scheduled_idx"
  ON "broadcasts" ("tenant_id", "scheduled_for")
  WHERE "status" = 'approved' AND "scheduled_for" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "broadcasts_resend_broadcast_id_uniq"
  ON "broadcasts" ("resend_broadcast_id")
  WHERE "resend_broadcast_id" IS NOT NULL;--> statement-breakpoint

-- --- 4. Row-Level Security (Constitution v1.4.0 Principle I clause 2) -------

ALTER TABLE "broadcasts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcasts" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcasts"
  ON "broadcasts"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 5. Trigger: immutable-after-submit (Q3 + FR-004) -----------------------
-- Defence-in-depth pairing with Application-layer
-- `submit-broadcast.ts` use-case + Domain
-- `policies/broadcast-status-transitions.ts`. Blocks subject/body/segment
-- mutation when OLD.status != 'draft'. Members must cancel + re-draft to
-- change content after submission.

CREATE OR REPLACE FUNCTION broadcasts_immutable_after_submit_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status != 'draft' THEN
    IF NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_html IS DISTINCT FROM OLD.body_html
       OR NEW.body_source IS DISTINCT FROM OLD.body_source
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for THEN
      RAISE EXCEPTION 'broadcast_immutable_after_submit'
        USING ERRCODE = 'check_violation',
              HINT    = 'Cancel and create a new draft to change content (FR-004 + Clarifications Q3).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER broadcasts_immutable_after_submit
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION broadcasts_immutable_after_submit_fn();--> statement-breakpoint

-- --- 6. Trigger: state machine (FR-004 + FR-004a) ---------------------------
-- Defence-in-depth pairing with Domain
-- `policies/broadcast-status-transitions.ts`. Enforces the 8-state
-- adjacency table at DB level. Both layers MUST agree — drift surfaces
-- as `check_violation` from this trigger if Application drifts.

CREATE OR REPLACE FUNCTION broadcasts_state_machine_fn()
RETURNS TRIGGER AS $$
DECLARE
  allowed_targets text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;  -- no transition; non-status updates allowed (resend_audience_id, scheduled_for, etc.)
  END IF;

  CASE OLD.status
    WHEN 'draft'              THEN allowed_targets := ARRAY['submitted', 'cancelled'];
    WHEN 'submitted'          THEN allowed_targets := ARRAY['approved', 'rejected', 'cancelled'];
    WHEN 'approved'           THEN allowed_targets := ARRAY['sending', 'cancelled', 'failed_to_dispatch'];
    WHEN 'sending'            THEN allowed_targets := ARRAY['sent', 'failed_to_dispatch'];
    WHEN 'sent'               THEN allowed_targets := ARRAY[]::text[];
    WHEN 'rejected'           THEN allowed_targets := ARRAY[]::text[];
    WHEN 'cancelled'          THEN allowed_targets := ARRAY[]::text[];
    WHEN 'failed_to_dispatch' THEN allowed_targets := ARRAY[]::text[];
  END CASE;

  IF NOT (NEW.status::text = ANY (allowed_targets)) THEN
    RAISE EXCEPTION 'broadcast_invalid_state_transition'
      USING ERRCODE = 'check_violation',
            DETAIL  = format('cannot transition broadcast from %s to %s', OLD.status, NEW.status),
            HINT    = 'See FR-004 + FR-004a state machine.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER broadcasts_state_machine
  BEFORE UPDATE OF status ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION broadcasts_state_machine_fn();--> statement-breakpoint

-- --- 7. Trigger: updated_at touch (standard) --------------------------------

CREATE OR REPLACE FUNCTION broadcasts_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER broadcasts_set_updated_at
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION broadcasts_set_updated_at_fn();--> statement-breakpoint

-- --- 8. Grants for chamber_app role -----------------------------------------
-- Mirror of F4/F5 pattern from migration 0022_invoicing_chamber_app_grants.sql.
-- The `chamber_app` role is the runtime DB user; grants are limited to DML
-- (no DDL).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "broadcasts" TO chamber_app;--> statement-breakpoint
