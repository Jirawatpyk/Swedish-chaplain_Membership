-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T019 — renewal_reminder_events table.
--
-- Idempotent log of every reminder dispatched (or attempted) for a renewal
-- cycle. The cron dispatcher inserts one row per (cycle, step, year-in-
-- cycle); the unique index makes re-running the daily cron a no-op so
-- multiple cron-job.org invocations cannot produce duplicate sends.
--
-- Two channels:
--   * email — F1+F4 transactional Resend dispatch (research.md R1).
--             `template_id` carries the localised template identifier;
--             `delivery_id` is the Resend message id for webhook
--             correlation.
--   * task  — admin-facing escalation task (e.g., quarterly_review_meeting
--             reminder). `task_type` carries the task variant. No
--             external delivery — task rows are surfaced via the F8
--             escalation queue (renewal_escalation_tasks, T023).
--
-- Multi-year cycles: `year_in_cycle ∈ {1, 2, 3, ...}` differentiates
-- per-year task firings. Single-year cycles always have year_in_cycle=1.
--
-- Source of truth: data-model.md § 2.2.
-- ---------------------------------------------------------------------------

CREATE TABLE "renewal_reminder_events" (
  "tenant_id"          text        NOT NULL,
  "reminder_event_id"  uuid        NOT NULL DEFAULT gen_random_uuid(),

  -- FK target — F8 renewal_cycles delivered by 0087.
  "cycle_id"           uuid        NOT NULL,

  -- Step identity (e.g., 't-30.email', 't-90.task.quarterly_review').
  -- Free-form text at DB level; enumerated by the schedule-policy
  -- Domain entity (Wave D T033).
  "step_id"            text        NOT NULL,
  "channel"            text        NOT NULL,
  "template_id"        text,
  "task_type"          text,

  -- Lifecycle.
  "dispatched_at"      timestamptz,
  "delivery_id"        text,
  "status"             text        NOT NULL DEFAULT 'pending',
  "skip_reason"        text,
  "failure_reason"     text,

  -- Actor — NULL for cron-driven sends, admin user UUID for manual sends.
  "actor_user_id"      uuid,

  -- Multi-year support — see header.
  "year_in_cycle"      smallint    NOT NULL DEFAULT 1,

  "created_at"         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "renewal_reminder_events_pk"
    PRIMARY KEY ("tenant_id", "reminder_event_id"),

  -- Composite FK to renewal_cycles. CASCADE so deleting a cycle
  -- (rare — only via test cleanup or admin-only purge tooling) does
  -- not leave orphan reminder rows.
  CONSTRAINT "renewal_reminder_events_cycle_fk"
    FOREIGN KEY ("tenant_id", "cycle_id")
    REFERENCES "renewal_cycles" ("tenant_id", "cycle_id")
    ON DELETE CASCADE,

  -- Channel + status enums.
  CONSTRAINT "renewal_reminder_events_channel_check"
    CHECK ("channel" IN ('email', 'task')),
  CONSTRAINT "renewal_reminder_events_status_check"
    CHECK ("status" IN ('pending', 'sent', 'skipped', 'failed')),

  -- Channel ↔ template/task discriminant (data-model.md L167–170):
  -- email rows MUST have template_id + NULL task_type;
  -- task rows MUST have task_type + NULL template_id.
  CONSTRAINT "renewal_reminder_events_channel_payload_check"
    CHECK (
      ("channel" = 'email' AND "template_id" IS NOT NULL AND "task_type" IS NULL)
      OR ("channel" = 'task' AND "task_type" IS NOT NULL AND "template_id" IS NULL)
    ),

  -- year_in_cycle ≥ 1 (Domain narrows to {1, 2, 3, …} per data-model L195).
  CONSTRAINT "renewal_reminder_events_year_in_cycle_check"
    CHECK ("year_in_cycle" >= 1),

  -- Status-timestamp invariants — defence in depth alongside the
  -- Domain rules (Wave D Domain entity will mirror these).
  --   sent → dispatched_at NOT NULL AND failure_reason NULL AND skip_reason NULL
  CONSTRAINT "renewal_reminder_events_sent_check"
    CHECK (
      "status" != 'sent'
      OR ("dispatched_at" IS NOT NULL
          AND "failure_reason" IS NULL
          AND "skip_reason" IS NULL)
    ),
  --   skipped → skip_reason NOT NULL AND dispatched_at NULL
  CONSTRAINT "renewal_reminder_events_skipped_check"
    CHECK (
      "status" != 'skipped'
      OR ("skip_reason" IS NOT NULL AND "dispatched_at" IS NULL)
    ),
  --   failed → failure_reason NOT NULL AND dispatched_at NULL
  CONSTRAINT "renewal_reminder_events_failed_check"
    CHECK (
      "status" != 'failed'
      OR ("failure_reason" IS NOT NULL AND "dispatched_at" IS NULL)
    ),
  --   pending → all lifecycle fields NULL
  CONSTRAINT "renewal_reminder_events_pending_check"
    CHECK (
      "status" != 'pending'
      OR ("dispatched_at" IS NULL
          AND "delivery_id" IS NULL
          AND "failure_reason" IS NULL
          AND "skip_reason" IS NULL)
    )
);--> statement-breakpoint

-- --- 2. Indexes -------------------------------------------------------------

-- Idempotency primitive — re-running the daily cron cannot insert
-- duplicate (cycle, step, year) rows. The dispatcher relies on
-- `INSERT … ON CONFLICT DO NOTHING` against this index to short-circuit
-- already-dispatched steps without a prior SELECT.
CREATE UNIQUE INDEX "renewal_reminder_events_idem_idx"
  ON "renewal_reminder_events" ("tenant_id", "cycle_id", "step_id", "year_in_cycle");--> statement-breakpoint

-- Recent-activity feed (admin pipeline detail page + ops dashboards).
CREATE INDEX "renewal_reminder_events_recent_idx"
  ON "renewal_reminder_events" ("tenant_id", "dispatched_at" DESC);--> statement-breakpoint

-- Failure cursor for retry tooling + ops alerts.
CREATE INDEX "renewal_reminder_events_failed_idx"
  ON "renewal_reminder_events" ("tenant_id", "status")
  WHERE "status" = 'failed';--> statement-breakpoint

-- --- 3. Row-Level Security (Constitution v1.4.0 Principle I clause 2) -------

ALTER TABLE "renewal_reminder_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "renewal_reminder_events" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_renewal_reminder_events"
  ON "renewal_reminder_events"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 4. Grants for chamber_app role -----------------------------------------
-- No `updated_at` trigger on this table — rows are append-only-ish:
-- inserted as `pending`, then transitioned ONCE to a terminal status
-- via a single UPDATE. The created_at + dispatched_at columns capture
-- everything an audit reader needs.

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "renewal_reminder_events"
  TO chamber_app;--> statement-breakpoint
