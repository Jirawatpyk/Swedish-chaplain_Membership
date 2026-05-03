-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T017 — scheduled_plan_changes table.
--
-- F2 cross-module table (per plan.md Complexity Tracking #4 + research.md R13).
-- F2 owns the LOGICAL schema (the use-cases that read/write this table live
-- in `src/modules/plans/application/`); F8 owns the MIGRATION DELIVERY per
-- F7 precedent of F8-owns-all-9-migrations.
--
-- One pending row per (tenant, member, target renewal cycle). Captures an
-- admin's intent to switch a member's plan AT the next renewal boundary, NOT
-- immediately. F4's renewal-invoice-creation hook resolves the effective
-- plan via this table; F8's accepted-tier-upgrade flow inserts here; F4
-- invoice-paid path transitions `pending → applied` atomically with the
-- `members.plan_id` update (Phase 5+).
--
-- Source of truth: data-model.md § 2.9.
-- ---------------------------------------------------------------------------

-- --- 1. Table ----------------------------------------------------------------

CREATE TABLE "scheduled_plan_changes" (
  "tenant_id"              text NOT NULL,
  "scheduled_change_id"    uuid NOT NULL DEFAULT gen_random_uuid(),
  "member_id"              uuid NOT NULL,
  "effective_at_cycle_id"  uuid NOT NULL,
  "from_plan_id"           text NOT NULL,
  "to_plan_id"             text NOT NULL,
  "scheduled_by_user_id"   uuid NOT NULL,
  "reason"                 text,
  "status"                 text NOT NULL DEFAULT 'pending',
  "scheduled_at"           timestamptz NOT NULL DEFAULT now(),
  "applied_at"             timestamptz,
  "superseded_at"          timestamptz,
  "cancelled_at"           timestamptz,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "scheduled_plan_changes_pk"
    PRIMARY KEY ("tenant_id", "scheduled_change_id"),
  CONSTRAINT "scheduled_plan_changes_status_check"
    CHECK ("status" IN ('pending', 'applied', 'superseded', 'cancelled')),
  -- Terminal-state timestamp invariants (Domain state machine mirrors these
  -- in `src/modules/plans/domain/scheduled-plan-change.ts`).
  CONSTRAINT "scheduled_plan_changes_applied_at_invariant"
    CHECK (
      ("status" = 'applied' AND "applied_at" IS NOT NULL)
      OR ("status" != 'applied' AND "applied_at" IS NULL)
    ),
  CONSTRAINT "scheduled_plan_changes_superseded_at_invariant"
    CHECK (
      ("status" = 'superseded' AND "superseded_at" IS NOT NULL)
      OR ("status" != 'superseded' AND "superseded_at" IS NULL)
    ),
  CONSTRAINT "scheduled_plan_changes_cancelled_at_invariant"
    CHECK (
      ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL)
      OR ("status" != 'cancelled' AND "cancelled_at" IS NULL)
    ),
  -- Domain rule: from ≠ to (no-op schedules rejected at API boundary too).
  CONSTRAINT "scheduled_plan_changes_from_to_distinct"
    CHECK ("from_plan_id" <> "to_plan_id")
);--> statement-breakpoint

-- --- 2. Indexes -------------------------------------------------------------

-- Partial unique enforcing the "at most one pending row per (tenant, member,
-- target cycle)" invariant. Terminal rows (`applied`/`superseded`/`cancelled`)
-- are EXCLUDED from this constraint so the audit trail can carry many rows.
CREATE UNIQUE INDEX "scheduled_plan_changes_pending_uniq"
  ON "scheduled_plan_changes" ("tenant_id", "member_id", "effective_at_cycle_id")
  WHERE "status" = 'pending';--> statement-breakpoint

-- Hot-path lookup by (tenant, member, cycle) — F4's `getEffectivePlanForRenewal`
-- resolver hits this on every renewal-invoice creation.
CREATE INDEX "scheduled_plan_changes_member_cycle_idx"
  ON "scheduled_plan_changes" ("tenant_id", "member_id", "effective_at_cycle_id");--> statement-breakpoint

-- --- 3. Row-Level Security (Constitution v1.4.0 Principle I clause 2) -------

ALTER TABLE "scheduled_plan_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_plan_changes" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_scheduled_plan_changes"
  ON "scheduled_plan_changes"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 4. Trigger: updated_at touch (standard) --------------------------------

CREATE OR REPLACE FUNCTION scheduled_plan_changes_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER scheduled_plan_changes_set_updated_at
  BEFORE UPDATE ON scheduled_plan_changes
  FOR EACH ROW
  EXECUTE FUNCTION scheduled_plan_changes_set_updated_at_fn();--> statement-breakpoint

-- --- 5. Grants for chamber_app role -----------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "scheduled_plan_changes"
  TO chamber_app;--> statement-breakpoint
