-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T023 — renewal_escalation_tasks table.
--
-- Manual admin/ED tasks dispatched alongside reminder emails (e.g.
-- quarterly_review_meeting, phone_call, board_escalation,
-- verify_pending_tier_upgrade) + the FR-005c
-- `manual_admin_reactivation_review` task triggered when a lapsed
-- blocked-from-auto-reactivation member completes payment.
--
-- 3-state lifecycle: open → done | skipped (terminal). Idempotency
-- enforces "at most one open task per (member, cycle, task_type)" so
-- the dispatcher cron cannot create duplicate tasks on retries.
--
-- Source of truth: data-model.md § 2.7.
-- ---------------------------------------------------------------------------

CREATE TABLE "renewal_escalation_tasks" (
  "tenant_id"             text        NOT NULL,
  "task_id"               uuid        NOT NULL DEFAULT gen_random_uuid(),
  "member_id"             uuid        NOT NULL,
  -- NULL for non-cycle tasks (e.g. verify_pending_tier_upgrade T-180).
  "cycle_id"              uuid,
  "task_type"             text        NOT NULL,
  "assigned_to_role"      text        NOT NULL,
  "assigned_to_user_id"   uuid,
  "due_at"                timestamptz NOT NULL,
  "status"                text        NOT NULL DEFAULT 'open',
  "outcome_note"          text,
  "skipped_reason"        text,
  "closed_by_user_id"     uuid,
  -- For verify_pending_tier_upgrade tasks linking back to the
  -- triggering tier_upgrade_suggestions row.
  "related_suggestion_id" uuid,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "closed_at"             timestamptz,

  CONSTRAINT "renewal_escalation_tasks_pk"
    PRIMARY KEY ("tenant_id", "task_id"),

  CONSTRAINT "renewal_escalation_tasks_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id")
    ON DELETE CASCADE,

  -- Composite FK to renewal_cycles (nullable cycle_id allowed via
  -- MATCH SIMPLE — Postgres treats either FK column NULL as no
  -- constraint check). NO ACTION on delete preserves task history
  -- after cycle deletion (rare).
  CONSTRAINT "renewal_escalation_tasks_cycle_fk"
    FOREIGN KEY ("tenant_id", "cycle_id")
    REFERENCES "renewal_cycles" ("tenant_id", "cycle_id")
    ON DELETE NO ACTION,

  CONSTRAINT "renewal_escalation_tasks_status_check"
    CHECK ("status" IN ('open', 'done', 'skipped')),
  CONSTRAINT "renewal_escalation_tasks_assigned_to_role_check"
    CHECK ("assigned_to_role" IN ('admin', 'manager', 'executive_director')),
  CONSTRAINT "renewal_escalation_tasks_outcome_note_length_check"
    CHECK ("outcome_note" IS NULL OR length("outcome_note") <= 1000),
  CONSTRAINT "renewal_escalation_tasks_skipped_reason_length_check"
    CHECK ("skipped_reason" IS NULL OR length("skipped_reason") <= 500),

  -- Status-lifecycle invariants.
  --   open → closed_at NULL
  CONSTRAINT "renewal_escalation_tasks_open_check"
    CHECK ("status" != 'open' OR "closed_at" IS NULL),
  --   done → closed_at NOT NULL + closed_by_user_id NOT NULL
  CONSTRAINT "renewal_escalation_tasks_done_check"
    CHECK (
      "status" != 'done'
      OR ("closed_at" IS NOT NULL AND "closed_by_user_id" IS NOT NULL)
    ),
  --   skipped → closed_at NOT NULL + skipped_reason NOT NULL
  CONSTRAINT "renewal_escalation_tasks_skipped_check"
    CHECK (
      "status" != 'skipped'
      OR ("closed_at" IS NOT NULL AND "skipped_reason" IS NOT NULL)
    )
);--> statement-breakpoint

-- Per-tenant queue cursor (admin task list).
CREATE INDEX "renewal_escalation_tasks_queue_idx"
  ON "renewal_escalation_tasks" ("tenant_id", "status", "due_at");--> statement-breakpoint

-- Per-user "my open tasks" view.
CREATE INDEX "renewal_escalation_tasks_per_user_idx"
  ON "renewal_escalation_tasks" ("tenant_id", "assigned_to_user_id", "status")
  WHERE "status" = 'open';--> statement-breakpoint

-- Idempotency: at most one open task per (member, cycle, task_type).
-- NULL cycle_id is permitted — the partial index still enforces
-- uniqueness for the "task is open" subset.
CREATE UNIQUE INDEX "renewal_escalation_tasks_open_idem_idx"
  ON "renewal_escalation_tasks" ("tenant_id", "member_id", "cycle_id", "task_type")
  WHERE "status" = 'open';--> statement-breakpoint

ALTER TABLE "renewal_escalation_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "renewal_escalation_tasks" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_renewal_escalation_tasks"
  ON "renewal_escalation_tasks"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "renewal_escalation_tasks"
  TO chamber_app;--> statement-breakpoint
