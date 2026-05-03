-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T018 — renewal_cycles table.
--
-- One row per (member, cycle). Tracks the lifecycle of one renewal period.
-- Aggregate root for the F8 bounded context — the cycle is the unit of
-- renewal-tracking work. F4's renewal-invoice-creation hook (Phase 5+)
-- creates an `upcoming` cycle when prior cycle paid; F8's reminder
-- dispatcher transitions to `reminded`; T-0 expiry transitions to
-- `awaiting_payment`; F4 invoice-paid hook transitions to `completed`;
-- grace-period exhaustion transitions to `lapsed`; admin actions can
-- cancel from any non-terminal state.
--
-- 7-state machine extended at /speckit.clarify round 3 Q1 +
-- /speckit.critique round 2 / M3 with `pending_admin_reactivation` to
-- support the FR-005c admin-reactivation flow (lapsed member returns,
-- pays, but admin must explicitly approve before the renewal lands).
--
-- Frozen-plan snapshot columns (FR-021a, /speckit.clarify round 3 Q2)
-- pin the plan price + term + currency at cycle creation time so that
-- mid-cycle plan-catalogue mutations don't retroactively change what
-- this cycle was priced against.
--
-- Source of truth: data-model.md § 2.1.
-- ---------------------------------------------------------------------------

CREATE TABLE "renewal_cycles" (
  "tenant_id"                  text        NOT NULL,
  "cycle_id"                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  "member_id"                  uuid        NOT NULL,

  -- 7-state machine (data-model.md § 2.1 state diagram L83–126).
  "status"                     text        NOT NULL DEFAULT 'upcoming',

  -- Period bounds.
  "period_from"                timestamptz NOT NULL,
  "period_to"                  timestamptz NOT NULL,
  -- Denormalised copy of period_to indexed on the pipeline hot-path
  -- query. Trigger maintains the `period_to === expires_at` invariant.
  "expires_at"                 timestamptz NOT NULL,
  "cycle_length_months"        smallint    NOT NULL DEFAULT 12,

  -- Frozen tier-bucket + plan snapshot (FR-021a, /speckit.clarify
  -- round 3 Q2). Stored at cycle creation; NEVER overwritten.
  "tier_at_cycle_start"        text        NOT NULL,
  "plan_id_at_cycle_start"     uuid        NOT NULL,
  "frozen_plan_price_thb"      decimal(12, 2) NOT NULL,
  "frozen_plan_term_months"    smallint    NOT NULL,
  "frozen_plan_currency"       text        NOT NULL DEFAULT 'THB',

  -- pending_admin_reactivation tracking (Q1 round 3).
  -- Set when status → 'pending_admin_reactivation'; reset to NULL on
  -- transition out. Used by FR-005c reminder ladder (T-7/T-3/T-1).
  "entered_pending_at"         timestamptz,

  -- Lifecycle anchors.
  "linked_invoice_id"          uuid,
  -- Composite FK to F4 (tenant_id, invoice_id). NULL until F4
  -- renewal-invoice ships.
  "linked_credit_note_id"      uuid,
  -- Composite FK to F4 credit_notes for the FR-005b admin-rejection
  -- refund path. NULL until that flow runs.
  "closed_at"                  timestamptz,
  "closed_reason"              text,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "renewal_cycles_pk"
    PRIMARY KEY ("tenant_id", "cycle_id"),

  -- F3 FK — RESTRICT prevents member archival when active cycles exist.
  CONSTRAINT "renewal_cycles_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id")
    ON DELETE RESTRICT,

  -- F4 FKs — composite (tenant_id, …_id). NO ACTION lets F4 enforce
  -- its own retention rules independently; F8 reads via JOIN per
  -- data-model.md L75 single-LEFT-JOIN guidance.
  CONSTRAINT "renewal_cycles_linked_invoice_fk"
    FOREIGN KEY ("tenant_id", "linked_invoice_id")
    REFERENCES "invoices" ("tenant_id", "invoice_id")
    ON DELETE NO ACTION,

  CONSTRAINT "renewal_cycles_linked_credit_note_fk"
    FOREIGN KEY ("tenant_id", "linked_credit_note_id")
    REFERENCES "credit_notes" ("tenant_id", "credit_note_id")
    ON DELETE NO ACTION,

  -- 7-state CHECK (Q1 round 3 + M3 round 2).
  CONSTRAINT "renewal_cycles_status_check"
    CHECK ("status" IN (
      'upcoming',
      'reminded',
      'awaiting_payment',
      'completed',
      'lapsed',
      'cancelled',
      'pending_admin_reactivation'
    )),

  -- closed_reason enum mirrors data-model.md L46.
  CONSTRAINT "renewal_cycles_closed_reason_check"
    CHECK (
      "closed_reason" IS NULL
      OR "closed_reason" IN (
        'paid',
        'cancelled',
        'lapsed',
        'completed_offline',
        'admin_reactivated',
        'admin_rejected_with_refund',
        'pending_reactivation_timed_out'
      )
    ),

  -- Period invariants.
  CONSTRAINT "renewal_cycles_cycle_length_months_check"
    CHECK ("cycle_length_months" > 0 AND "cycle_length_months" <= 60),
  CONSTRAINT "renewal_cycles_period_order_check"
    CHECK ("period_to" > "period_from"),

  -- Frozen-snapshot invariants.
  CONSTRAINT "renewal_cycles_frozen_plan_price_check"
    CHECK ("frozen_plan_price_thb" >= 0),
  CONSTRAINT "renewal_cycles_frozen_plan_term_check"
    CHECK ("frozen_plan_term_months" > 0 AND "frozen_plan_term_months" <= 60),

  -- Domain invariants from data-model.md L137–138.
  --   completed → linked_invoice_id NOT NULL
  CONSTRAINT "renewal_cycles_completed_requires_invoice_check"
    CHECK (
      "status" != 'completed'
      OR "linked_invoice_id" IS NOT NULL
    ),
  --   closed_at NOT NULL ↔ status IN terminal
  CONSTRAINT "renewal_cycles_closed_at_iff_terminal_check"
    CHECK (
      ("status" IN ('completed', 'lapsed', 'cancelled')
        AND "closed_at" IS NOT NULL)
      OR ("status" NOT IN ('completed', 'lapsed', 'cancelled')
        AND "closed_at" IS NULL)
    ),
  --   pending_admin_reactivation ↔ entered_pending_at NOT NULL
  CONSTRAINT "renewal_cycles_pending_at_iff_pending_status_check"
    CHECK (
      ("status" = 'pending_admin_reactivation'
        AND "entered_pending_at" IS NOT NULL)
      OR ("status" != 'pending_admin_reactivation'
        AND "entered_pending_at" IS NULL)
    )
);--> statement-breakpoint

-- --- 2. Indexes -------------------------------------------------------------

-- Pipeline dashboard hot path (FR-046 list + summary).
CREATE INDEX "renewal_cycles_pipeline_idx"
  ON "renewal_cycles" ("tenant_id", "status", "expires_at");--> statement-breakpoint

-- Per-member lookup (member portal renewal page + admin drill-down).
CREATE INDEX "renewal_cycles_member_idx"
  ON "renewal_cycles" ("tenant_id", "member_id");--> statement-breakpoint

-- Eligibility cursor for the dispatcher cron (FR-046 reminder ladder).
CREATE INDEX "renewal_cycles_eligibility_idx"
  ON "renewal_cycles" ("tenant_id", "status", "expires_at")
  WHERE "status" IN ('upcoming', 'reminded', 'awaiting_payment');--> statement-breakpoint

-- Invariant L135 (data-model.md): a member has AT MOST ONE active cycle.
-- Partial UNIQUE enforces it at the DB layer — Domain rule mirrored.
CREATE UNIQUE INDEX "renewal_cycles_active_member_uniq"
  ON "renewal_cycles" ("tenant_id", "member_id")
  WHERE "status" NOT IN ('lapsed', 'cancelled', 'completed');--> statement-breakpoint

-- --- 3. Row-Level Security (Constitution v1.4.0 Principle I clause 2) -------

ALTER TABLE "renewal_cycles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "renewal_cycles" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_renewal_cycles"
  ON "renewal_cycles"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 4. Trigger: maintain expires_at = period_to ----------------------------
-- The `expires_at` column is a denormalised copy of `period_to` — kept as
-- a separate column purely so the pipeline_idx can index it directly
-- (composite indexes on calculated values are awkward in pg). The
-- trigger forces the equality on every INSERT/UPDATE so the invariant
-- can never drift.

CREATE OR REPLACE FUNCTION renewal_cycles_sync_expires_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.expires_at := NEW.period_to;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER renewal_cycles_sync_expires_at
  BEFORE INSERT OR UPDATE ON renewal_cycles
  FOR EACH ROW
  EXECUTE FUNCTION renewal_cycles_sync_expires_at_fn();--> statement-breakpoint

-- --- 5. Trigger: updated_at touch (standard) --------------------------------

CREATE OR REPLACE FUNCTION renewal_cycles_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER renewal_cycles_set_updated_at
  BEFORE UPDATE ON renewal_cycles
  FOR EACH ROW
  EXECUTE FUNCTION renewal_cycles_set_updated_at_fn();--> statement-breakpoint

-- --- 6. Grants for chamber_app role -----------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "renewal_cycles"
  TO chamber_app;--> statement-breakpoint
