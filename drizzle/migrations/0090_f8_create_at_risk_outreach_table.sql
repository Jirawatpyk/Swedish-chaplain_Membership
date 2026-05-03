-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T021 — at_risk_outreach table.
--
-- Append-only log of admin outreach to at-risk members (email/phone/
-- meeting) with optional outcome note. Surfaced as the at-risk widget's
-- history view + linked back to audit_log via `related_audit_event_id`.
--
-- Source of truth: data-model.md § 2.5.
-- ---------------------------------------------------------------------------

CREATE TABLE "at_risk_outreach" (
  "tenant_id"               text        NOT NULL,
  "outreach_id"             uuid        NOT NULL DEFAULT gen_random_uuid(),
  "member_id"               uuid        NOT NULL,
  "channel"                 text        NOT NULL,
  "template_id"             text,
  "outcome_note"            text,
  "actor_user_id"           uuid        NOT NULL,
  "related_audit_event_id"  uuid,
  "created_at"              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "at_risk_outreach_pk"
    PRIMARY KEY ("tenant_id", "outreach_id"),

  CONSTRAINT "at_risk_outreach_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id")
    ON DELETE CASCADE,

  CONSTRAINT "at_risk_outreach_channel_check"
    CHECK ("channel" IN ('email', 'phone', 'meeting')),
  -- Outcome note free-text; soft cap at 500 chars (data-model L286).
  CONSTRAINT "at_risk_outreach_outcome_note_length_check"
    CHECK ("outcome_note" IS NULL OR length("outcome_note") <= 500),
  -- Email channel must carry template_id; phone/meeting must not.
  CONSTRAINT "at_risk_outreach_channel_template_check"
    CHECK (
      ("channel" = 'email' AND "template_id" IS NOT NULL)
      OR ("channel" != 'email' AND "template_id" IS NULL)
    )
);--> statement-breakpoint

CREATE INDEX "at_risk_outreach_member_timeline_idx"
  ON "at_risk_outreach" ("tenant_id", "member_id", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "at_risk_outreach" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "at_risk_outreach" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_at_risk_outreach"
  ON "at_risk_outreach"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "at_risk_outreach"
  TO chamber_app;--> statement-breakpoint
