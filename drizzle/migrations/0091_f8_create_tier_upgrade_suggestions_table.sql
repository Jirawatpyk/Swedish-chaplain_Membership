-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T022 — tier_upgrade_suggestions table.
--
-- Auto-generated suggestions to upgrade a member's plan based on
-- declared turnover OR paid-invoice volume signals. 6-state lifecycle
-- (open → accepted_pending_apply → applied | superseded;
--  open → dismissed; cron auto-dismiss → auto_resolved).
--
-- Pending-apply lifecycle (Q5 round 2): admin Accepts → suggestion
-- enters `accepted_pending_apply`; F4's renewal-invoice-creation hook
-- reads pending suggestions to upgrade the plan at next cycle boundary
-- (Phase 5+ T183). After F4 invoice paid → suggestion → `applied`.
-- F2 manual `member_plan_changed` event between Accept and Apply →
-- suggestion → `superseded` (cf. F2 schedule-plan-change use-case).
--
-- Source of truth: data-model.md § 2.6.
-- ---------------------------------------------------------------------------

CREATE TABLE "tier_upgrade_suggestions" (
  "tenant_id"                  text        NOT NULL,
  "suggestion_id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
  "member_id"                  uuid        NOT NULL,
  "from_plan_id"               uuid        NOT NULL,
  "to_plan_id"                 uuid        NOT NULL,
  -- Reason taxonomy (data-model.md § 2.6 + § 4 audit catalogue).
  "reason_code"                text        NOT NULL,
  "evidence_jsonb"             jsonb       NOT NULL,

  -- 6-state machine (extended at /speckit.clarify Q5 round 2).
  "status"                     text        NOT NULL DEFAULT 'open',
  "suppressed_until"           timestamptz,
  "dismissed_reason"           text,

  -- Pending-application fields (Q5 round 2).
  "accepted_at"                timestamptz,
  "accepted_by_user_id"        uuid,
  "target_apply_at_cycle_id"   uuid,
  "applied_at"                 timestamptz,
  "applied_at_invoice_id"      uuid,
  "member_notified_at"         timestamptz,
  "admin_verification_task_id" uuid,

  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "closed_at"                  timestamptz,

  CONSTRAINT "tier_upgrade_suggestions_pk"
    PRIMARY KEY ("tenant_id", "suggestion_id"),

  CONSTRAINT "tier_upgrade_suggestions_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id")
    ON DELETE CASCADE,

  CONSTRAINT "tier_upgrade_suggestions_status_check"
    CHECK ("status" IN (
      'open',
      'accepted_pending_apply',
      'applied',
      'dismissed',
      'superseded',
      'auto_resolved'
    )),
  CONSTRAINT "tier_upgrade_suggestions_reason_code_check"
    CHECK ("reason_code" IN (
      'declared_turnover_above_threshold',
      'paid_invoice_volume_above_threshold',
      'multi_signal'
    )),
  CONSTRAINT "tier_upgrade_suggestions_dismissed_reason_length_check"
    CHECK ("dismissed_reason" IS NULL OR length("dismissed_reason") <= 500),

  -- Domain invariants for the pending-apply lifecycle.
  --   accepted_pending_apply → accepted_at + accepted_by_user_id NOT NULL
  CONSTRAINT "tier_upgrade_suggestions_accepted_check"
    CHECK (
      "status" != 'accepted_pending_apply'
      OR ("accepted_at" IS NOT NULL
          AND "accepted_by_user_id" IS NOT NULL
          AND "target_apply_at_cycle_id" IS NOT NULL)
    ),
  --   applied → applied_at + applied_at_invoice_id NOT NULL + closed_at
  CONSTRAINT "tier_upgrade_suggestions_applied_check"
    CHECK (
      "status" != 'applied'
      OR ("applied_at" IS NOT NULL
          AND "applied_at_invoice_id" IS NOT NULL
          AND "closed_at" IS NOT NULL)
    ),
  --   dismissed → dismissed_reason NOT NULL + closed_at NOT NULL
  CONSTRAINT "tier_upgrade_suggestions_dismissed_check"
    CHECK (
      "status" != 'dismissed'
      OR ("dismissed_reason" IS NOT NULL AND "closed_at" IS NOT NULL)
    ),
  --   superseded + auto_resolved → closed_at NOT NULL
  CONSTRAINT "tier_upgrade_suggestions_terminal_closed_at_check"
    CHECK (
      "status" NOT IN ('superseded', 'auto_resolved')
      OR "closed_at" IS NOT NULL
    )
);--> statement-breakpoint

-- At most ONE open OR pending-apply suggestion per (tenant, member).
CREATE UNIQUE INDEX "tier_upgrade_suggestions_member_open_uniq"
  ON "tier_upgrade_suggestions" ("tenant_id", "member_id")
  WHERE "status" IN ('open', 'accepted_pending_apply');--> statement-breakpoint

-- Cron skip-eligibility (suppressed for 90 days after dismiss).
CREATE INDEX "tier_upgrade_suggestions_suppressed_idx"
  ON "tier_upgrade_suggestions" ("tenant_id", "status", "suppressed_until")
  WHERE "status" = 'dismissed';--> statement-breakpoint

-- F4 renewal-invoice hook reads pending applications by cycle.
CREATE INDEX "tier_upgrade_suggestions_pending_apply_idx"
  ON "tier_upgrade_suggestions" ("tenant_id", "target_apply_at_cycle_id")
  WHERE "status" = 'accepted_pending_apply';--> statement-breakpoint

ALTER TABLE "tier_upgrade_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tier_upgrade_suggestions" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tier_upgrade_suggestions"
  ON "tier_upgrade_suggestions"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "tier_upgrade_suggestions"
  TO chamber_app;--> statement-breakpoint
