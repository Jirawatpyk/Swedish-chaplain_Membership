-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T020 — tenant_renewal_settings + tenant_renewal_schedule_policies.
--
-- Two tables consolidated into one migration since both are per-tenant
-- configuration (not subject to high write volume) and ship together
-- at tenant onboarding.
--
-- `tenant_renewal_settings` — singleton-per-tenant config. grace period,
-- auto-upgrade flag, at-risk min-tenure, dispatch cron toggle, reply-to
-- defaults for renewal emails.
--
-- `tenant_renewal_schedule_policies` — 5 rows per tenant (one per
-- tier_bucket: thai_alumni, start_up, regular, premium, partnership).
-- `steps_jsonb` carries the reminder ladder for that bucket. Default
-- policy seeded for tenant_id='swecham' per data-model.md § 2.4
-- L266-271 + docs/smart-chamber-features.md § 4.
--
-- Source of truth: data-model.md § 2.3 + § 2.4.
-- ---------------------------------------------------------------------------

-- --- 1. tenant_renewal_settings --------------------------------------------

CREATE TABLE "tenant_renewal_settings" (
  "tenant_id"                   text        NOT NULL,
  "grace_period_days"           smallint    NOT NULL DEFAULT 14,
  "auto_upgrade_enabled"        boolean     NOT NULL DEFAULT TRUE,
  "min_tenure_days_for_at_risk" smallint    NOT NULL DEFAULT 30,
  "dispatch_cron_enabled"       boolean     NOT NULL DEFAULT TRUE,
  "reply_to_email"              text,
  "reply_to_display_name"       text,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "tenant_renewal_settings_pk"
    PRIMARY KEY ("tenant_id"),

  CONSTRAINT "tenant_renewal_settings_grace_period_check"
    CHECK ("grace_period_days" >= 0 AND "grace_period_days" <= 90),
  CONSTRAINT "tenant_renewal_settings_min_tenure_check"
    CHECK ("min_tenure_days_for_at_risk" >= 0 AND "min_tenure_days_for_at_risk" <= 365)
);--> statement-breakpoint

ALTER TABLE "tenant_renewal_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_renewal_settings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_renewal_settings"
  ON "tenant_renewal_settings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

CREATE OR REPLACE FUNCTION tenant_renewal_settings_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER tenant_renewal_settings_set_updated_at
  BEFORE UPDATE ON tenant_renewal_settings
  FOR EACH ROW
  EXECUTE FUNCTION tenant_renewal_settings_set_updated_at_fn();--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "tenant_renewal_settings"
  TO chamber_app;--> statement-breakpoint

-- --- 2. tenant_renewal_schedule_policies -----------------------------------

CREATE TABLE "tenant_renewal_schedule_policies" (
  "tenant_id"   text        NOT NULL,
  "tier_bucket" text        NOT NULL,
  "steps_jsonb" jsonb       NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "tenant_renewal_schedule_policies_pk"
    PRIMARY KEY ("tenant_id", "tier_bucket"),

  CONSTRAINT "tenant_renewal_schedule_policies_tier_bucket_check"
    CHECK ("tier_bucket" IN (
      'thai_alumni',
      'start_up',
      'regular',
      'premium',
      'partnership'
    )),

  -- steps_jsonb MUST be a JSON array (not object/scalar).
  CONSTRAINT "tenant_renewal_schedule_policies_steps_is_array_check"
    CHECK (jsonb_typeof("steps_jsonb") = 'array')
);--> statement-breakpoint

ALTER TABLE "tenant_renewal_schedule_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_renewal_schedule_policies" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_renewal_schedule_policies"
  ON "tenant_renewal_schedule_policies"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

CREATE OR REPLACE FUNCTION tenant_renewal_schedule_policies_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER tenant_renewal_schedule_policies_set_updated_at
  BEFORE UPDATE ON tenant_renewal_schedule_policies
  FOR EACH ROW
  EXECUTE FUNCTION tenant_renewal_schedule_policies_set_updated_at_fn();--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "tenant_renewal_schedule_policies"
  TO chamber_app;--> statement-breakpoint

-- --- 3. SweCham (TENANT_SLUG='swecham') default policy fixtures ------------
-- Seeds 5 default schedule-policy rows per data-model.md § 2.4 L266-271.
-- Step shape:
--   { step_id, offset_days (-N before expires_at, +N after), channel,
--     template_id (email channel), task_type (task channel), assignee_role }
-- Idempotent: ON CONFLICT DO NOTHING means re-running the migration on an
-- env that already has these rows is a no-op.

INSERT INTO "tenant_renewal_settings" ("tenant_id")
VALUES ('swecham')
ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "tenant_renewal_schedule_policies" ("tenant_id", "tier_bucket", "steps_jsonb")
VALUES
  ('swecham', 'thai_alumni', '[
    {"step_id":"t-30.email","offset_days":-30,"channel":"email","template_id":"renewal.t-30.thai_alumni"},
    {"step_id":"t-14.email","offset_days":-14,"channel":"email","template_id":"renewal.t-14.thai_alumni"},
    {"step_id":"t-3.email","offset_days":-3,"channel":"email","template_id":"renewal.t-3.thai_alumni"},
    {"step_id":"t+7.email","offset_days":7,"channel":"email","template_id":"renewal.t+7.thai_alumni"}
  ]'::jsonb),
  ('swecham', 'start_up', '[
    {"step_id":"t-60.email","offset_days":-60,"channel":"email","template_id":"renewal.t-60.start_up"},
    {"step_id":"t-30.email","offset_days":-30,"channel":"email","template_id":"renewal.t-30.start_up"},
    {"step_id":"t-14.email","offset_days":-14,"channel":"email","template_id":"renewal.t-14.start_up"},
    {"step_id":"t-7.email","offset_days":-7,"channel":"email","template_id":"renewal.t-7.start_up"},
    {"step_id":"t+0.email","offset_days":0,"channel":"email","template_id":"renewal.t+0.start_up"},
    {"step_id":"t+7.task.admin_notify","offset_days":7,"channel":"task","task_type":"admin_notify_lapsed","assignee_role":"admin"}
  ]'::jsonb),
  ('swecham', 'regular', '[
    {"step_id":"t-60.email","offset_days":-60,"channel":"email","template_id":"renewal.t-60.regular"},
    {"step_id":"t-30.email","offset_days":-30,"channel":"email","template_id":"renewal.t-30.regular"},
    {"step_id":"t-14.email","offset_days":-14,"channel":"email","template_id":"renewal.t-14.regular"},
    {"step_id":"t-7.email","offset_days":-7,"channel":"email","template_id":"renewal.t-7.regular"},
    {"step_id":"t+0.email","offset_days":0,"channel":"email","template_id":"renewal.t+0.regular"},
    {"step_id":"t+7.task.admin_notify","offset_days":7,"channel":"task","task_type":"admin_notify_lapsed","assignee_role":"admin"}
  ]'::jsonb),
  ('swecham', 'premium', '[
    {"step_id":"t-90.email","offset_days":-90,"channel":"email","template_id":"renewal.t-90.premium"},
    {"step_id":"t-60.email","offset_days":-60,"channel":"email","template_id":"renewal.t-60.premium"},
    {"step_id":"t-60.task.phone_call","offset_days":-60,"channel":"task","task_type":"phone_call","assignee_role":"admin"},
    {"step_id":"t-30.email","offset_days":-30,"channel":"email","template_id":"renewal.t-30.premium"},
    {"step_id":"t-14.email","offset_days":-14,"channel":"email","template_id":"renewal.t-14.premium"},
    {"step_id":"t-7.email","offset_days":-7,"channel":"email","template_id":"renewal.t-7.premium"},
    {"step_id":"t-7.task.phone_call","offset_days":-7,"channel":"task","task_type":"phone_call","assignee_role":"admin"},
    {"step_id":"t+0.email","offset_days":0,"channel":"email","template_id":"renewal.t+0.premium"},
    {"step_id":"t+14.task.director_call","offset_days":14,"channel":"task","task_type":"director_call","assignee_role":"executive_director"}
  ]'::jsonb),
  ('swecham', 'partnership', '[
    {"step_id":"t-120.task.quarterly_review","offset_days":-120,"channel":"task","task_type":"quarterly_review_meeting","assignee_role":"executive_director"},
    {"step_id":"t-90.email","offset_days":-90,"channel":"email","template_id":"renewal.t-90.partnership"},
    {"step_id":"t-90.task.meeting_proposed","offset_days":-90,"channel":"task","task_type":"meeting_proposed","assignee_role":"executive_director"},
    {"step_id":"t-60.task.benefit_fulfillment_report","offset_days":-60,"channel":"task","task_type":"benefit_fulfillment_report","assignee_role":"executive_director"},
    {"step_id":"t-30.email","offset_days":-30,"channel":"email","template_id":"renewal.t-30.partnership"},
    {"step_id":"t-30.task.contract","offset_days":-30,"channel":"task","task_type":"contract_renewal","assignee_role":"executive_director"},
    {"step_id":"t-14.task.ed_phone_call","offset_days":-14,"channel":"task","task_type":"phone_call","assignee_role":"executive_director"},
    {"step_id":"t+0.task.in_person_meeting","offset_days":0,"channel":"task","task_type":"in_person_meeting","assignee_role":"executive_director"},
    {"step_id":"t+30.task.board_escalation","offset_days":30,"channel":"task","task_type":"board_escalation","assignee_role":"executive_director"}
  ]'::jsonb)
ON CONFLICT ("tenant_id", "tier_bucket") DO NOTHING;--> statement-breakpoint
