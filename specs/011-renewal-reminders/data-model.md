# F8 — Renewal Tracking + Smart Reminders — Data Model

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 1 output (`/speckit.plan`)

---

## 1. Overview

F8 introduces **7 new tables** and **column extensions to 2 existing tables** (F3 `members`, F2 `membership_plans`). All 7 new tables are tenant-scoped via `tenant_id` + Postgres RLS+FORCE policies (Constitution v1.4.0 Principle I). F1's `users` and `audit_log` tables are reused unchanged.

Migrations **0086–0094** (nine files — extended at /speckit.tasks audit / M1; F7 post-ship migrations 0084 + 0085 already landed on main; F8 owns all 9 including F2 cross-module `scheduled_plan_changes` table per F7 precedent of F8-owns-all-migrations). All `CREATE INDEX CONCURRENTLY` statements live in separate post-migration scripts to avoid long-tx blocking.

---

## 2. New tables

### 2.1 `renewal_cycles`

One row per (member, cycle). Tracks the lifecycle of one renewal period.

```sql
CREATE TABLE renewal_cycles (
  tenant_id        TEXT NOT NULL,
  cycle_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL,
  status           TEXT NOT NULL DEFAULT 'upcoming',
  period_from      TIMESTAMPTZ NOT NULL,
  period_to        TIMESTAMPTZ NOT NULL,        -- = expires_at
  expires_at       TIMESTAMPTZ NOT NULL,        -- denormalised copy of period_to for index
  cycle_length_months SMALLINT NOT NULL DEFAULT 12,
  tier_at_cycle_start TEXT NOT NULL,            -- frozen tier_bucket at cycle creation
  plan_id_at_cycle_start UUID NOT NULL,
  -- Frozen price snapshot (added at /speckit.clarify round 3 Q2 + sync at /speckit.critique round 2 / M2)
  frozen_plan_price_thb DECIMAL(12, 2) NOT NULL,    -- frozen at cycle creation; 12.34 → 1234 cents-style if integer-encoded
  frozen_plan_term_months SMALLINT NOT NULL,        -- frozen at cycle creation
  frozen_plan_currency TEXT NOT NULL DEFAULT 'THB', -- frozen at cycle creation
  -- pending_admin_reactivation tracking (added at /speckit.clarify round 3 Q1 + M2)
  entered_pending_at TIMESTAMPTZ,                   -- set when status transitions to pending_admin_reactivation
  -- Lifecycle
  linked_invoice_id UUID,                       -- FK to F4 invoices when invoice issued
  linked_credit_note_id UUID,                   -- FK to F4 credit_notes when refund issued (FR-005b admin rejection path)
  closed_at        TIMESTAMPTZ,
  closed_reason    TEXT,                        -- 'paid' | 'cancelled' | 'lapsed' | 'completed_offline' | 'admin_reactivated' | 'admin_rejected_with_refund' | 'pending_reactivation_timed_out'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, cycle_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, member_id) ON DELETE RESTRICT,
  -- Status enum extended with pending_admin_reactivation (added at /speckit.clarify round 3 Q1 + M2)
  CHECK (status IN ('upcoming','reminded','awaiting_payment','completed','lapsed','cancelled','pending_admin_reactivation')),
  CHECK (cycle_length_months > 0 AND cycle_length_months <= 60),
  CHECK (period_to > period_from),
  CHECK (frozen_plan_price_thb >= 0),
  CHECK (frozen_plan_term_months > 0 AND frozen_plan_term_months <= 60)
);

ALTER TABLE renewal_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_cycles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON renewal_cycles
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

-- Indexes (all CONCURRENTLY in separate migration)
CREATE INDEX renewal_cycles_pipeline_idx ON renewal_cycles (tenant_id, status, expires_at);
-- Note (E5 / E14 from /speckit.critique 2026-05-03 round 1):
--   The pipeline dashboard's `summary.by_urgency` aggregation runs a GROUP BY on the urgency-bucket
--   derived from (expires_at - now()). At 600 visible rows the GROUP BY is fine; at 5000 rows it
--   risks 50-80ms latency that erodes the 500ms p95 budget. Mitigation options (chosen at impl time):
--     (a) Generated column `urgency_bucket TEXT GENERATED ALWAYS AS (...)` + index, OR
--     (b) Upstash Redis cache of summary with TTL 60s.
--   The list-row query MUST use a single LEFT JOIN to invoices to populate `linked_invoice_id`
--   in one round-trip (per E14) — NOT N+1 lookups per row.
CREATE INDEX renewal_cycles_member_idx ON renewal_cycles (tenant_id, member_id);
CREATE INDEX renewal_cycles_eligibility_idx ON renewal_cycles (tenant_id, status, expires_at)
  WHERE status IN ('upcoming','reminded','awaiting_payment');
CREATE INDEX renewal_cycles_active_member_idx ON renewal_cycles (tenant_id, member_id)
  WHERE status NOT IN ('lapsed','cancelled','completed');
```

### State machine (revised at /speckit.clarify round 3 Q1 + /speckit.critique round 2 / M3 — 7 states)

```
        ┌──────────┐
        │ upcoming │  (created when previous cycle paid OR first-time member; price frozen Q2)
        └────┬─────┘
             │ reminder dispatched
             ▼
        ┌──────────┐
        │ reminded │
        └────┬─────┘
             │ T-0 reached (expires_at hit)
             ▼
        ┌──────────────────┐
        │ awaiting_payment │ ← member can self-service renew during grace
        └─┬─────────┬───┬──┘
           │         │   │
   payment │   payment│   │ grace_period_days exceeded
   success │   success│   │
   (auto)  │   + admin│   │
           │   blocked│   ▼
           ▼         ▼   ┌────────┐
       ┌────────┐  ┌──────────────────────────┐  │ lapsed │ ──────► (member returns + pays)
       │ completed │  │ pending_admin_reactivation│  └────┬───┘            │
       │ (terminal)│  └─┬───────────────┬──────┘       │                │ + auto OR
       └────────┘    │               │              │                │ admin-blocked
                     │ admin         │ admin        │                │
                     │ approves      │ rejects      │                ▼
                     │               │ (refund)     │     (re-enters awaiting_payment OR
                     │               │              │      pending_admin_reactivation)
                     │               │              │
                     │ M3 timeout    │              │
                     │ 30d → auto-   │              │
                     │ cancel +      │              │
                     │ refund        │              │
                     ▼               ▼              ▼
                ┌────────┐      ┌──────────┐   (continue from awaiting_payment branch)
                │ completed│      │ cancelled│
                │(post-lapse)│   │+ refunded│
                └────────┘      └──────────┘
                                (terminal)

   (admin) cancel from any non-terminal state ─→ cancelled (terminal)
```

**State exit guarantees** (M3 — added at /speckit.critique round 2):
- `pending_admin_reactivation` MUST exit within 30 days via FR-005c auto-timeout cron OR earlier admin action.
- Reminder ladder T-7 / T-3 / T-1 day admin email reminders before timeout (escalation_task `manual_admin_reactivation_review` overdue highlights kick in earlier per FR-045).
- Auto-timeout transitions cycle to `cancelled` with `closed_reason='pending_reactivation_timed_out'` + audit `lapsed_member_admin_reactivation_timed_out` + F5 refund + F4 credit-note creation atomically.

### Invariants

- A member has at most ONE cycle in `status NOT IN ('completed','lapsed','cancelled')` at any time (enforced by partial unique index `renewal_cycles_active_member_idx` — the WHERE clause makes it natural).
- `period_to === expires_at` always (column is denormalised for index efficiency; trigger maintains identity).
- `status = 'completed'` requires `linked_invoice_id IS NOT NULL` (the F4 invoice that closed the cycle).
- `closed_at IS NOT NULL ↔ status IN ('completed','lapsed','cancelled')` (terminal states).

---

### 2.2 `renewal_reminder_events`

One row per dispatched (or attempted) reminder step. Idempotent insertion.

```sql
CREATE TABLE renewal_reminder_events (
  tenant_id        TEXT NOT NULL,
  reminder_event_id UUID NOT NULL DEFAULT gen_random_uuid(),
  cycle_id         UUID NOT NULL,
  step_id          TEXT NOT NULL,               -- e.g., 't-30.email', 't-90.task.quarterly_review'
  channel          TEXT NOT NULL,               -- 'email' | 'task'
  template_id      TEXT,                        -- e.g., 'renewal.t-30.premium'
  task_type        TEXT,                        -- e.g., 'quarterly_review_meeting'
  dispatched_at    TIMESTAMPTZ,
  delivery_id      TEXT,                        -- Resend message id (for email channel)
  status           TEXT NOT NULL DEFAULT 'pending',
  skip_reason      TEXT,
  failure_reason   TEXT,
  actor_user_id    UUID,                        -- NULL for cron, admin id for manual send
  year_in_cycle    SMALLINT NOT NULL DEFAULT 1, -- 1, 2, 3 for multi-year cycles
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, reminder_event_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES renewal_cycles(tenant_id, cycle_id) ON DELETE CASCADE,
  CHECK (channel IN ('email','task')),
  CHECK (status IN ('pending','sent','skipped','failed')),
  CHECK (
    (channel = 'email' AND template_id IS NOT NULL AND task_type IS NULL) OR
    (channel = 'task' AND task_type IS NOT NULL AND template_id IS NULL)
  )
);

ALTER TABLE renewal_reminder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_reminder_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON renewal_reminder_events
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

-- Idempotency primitive
CREATE UNIQUE INDEX renewal_reminder_events_idem_idx
  ON renewal_reminder_events (tenant_id, cycle_id, step_id, year_in_cycle);

CREATE INDEX renewal_reminder_events_recent_idx
  ON renewal_reminder_events (tenant_id, dispatched_at DESC);

CREATE INDEX renewal_reminder_events_failed_idx
  ON renewal_reminder_events (tenant_id, status)
  WHERE status = 'failed';
```

### Invariants

- Idempotency: `(tenant_id, cycle_id, step_id, year_in_cycle)` is unique → re-running the daily cron cannot insert duplicates.
- For multi-year cycles, `year_in_cycle ∈ {1, 2, 3, ...}` differentiates per-year task firings; for single-year cycles `year_in_cycle = 1` always.

---

### 2.3 `tenant_renewal_settings`

Per-tenant configuration. One row per tenant.

```sql
CREATE TABLE tenant_renewal_settings (
  tenant_id        TEXT PRIMARY KEY,
  grace_period_days SMALLINT NOT NULL DEFAULT 14,
  auto_upgrade_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_tenure_days_for_at_risk SMALLINT NOT NULL DEFAULT 30,
  dispatch_cron_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reply_to_email   TEXT,                         -- tenant-default reply-to for renewal emails
  reply_to_display_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (grace_period_days >= 0 AND grace_period_days <= 90),
  CHECK (min_tenure_days_for_at_risk >= 0 AND min_tenure_days_for_at_risk <= 365)
);

ALTER TABLE tenant_renewal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_renewal_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_renewal_settings
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));
```

---

### 2.4 `tenant_renewal_schedule_policies`

Per-tenant per-tier-bucket reminder schedule. Five rows per tenant by default.

```sql
CREATE TABLE tenant_renewal_schedule_policies (
  tenant_id        TEXT NOT NULL,
  tier_bucket      TEXT NOT NULL,
  steps_jsonb      JSONB NOT NULL,
  -- Schema for steps_jsonb:
  -- [
  --   {
  --     "step_id": "t-30.email",
  --     "offset_days": -30,           // negative = before expires_at
  --     "channel": "email" | "task",
  --     "template_id": "renewal.t-30.premium",  // for email channel
  --     "task_type": "quarterly_review_meeting", // for task channel
  --     "assignee_role": "admin" | "executive_director"  // for task channel
  --   },
  --   ...
  -- ]
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, tier_bucket),
  CHECK (tier_bucket IN ('thai_alumni','start_up','regular','premium','partnership'))
);

ALTER TABLE tenant_renewal_schedule_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_renewal_schedule_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_renewal_schedule_policies
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));
```

Default fixtures (per `docs/smart-chamber-features.md` § 4):

| `tier_bucket` | Steps |
|---|---|
| `thai_alumni` | T-30 email · T-14 email · T-3 email · T+7 email |
| `start_up` | T-60 email · T-30 email + dashboard widget · T-14 email · T-7 email · T+0 email · T+7 admin notify |
| `regular` | (same as start_up) |
| `premium` | T-90 email · T-60 email + phone-call task · T-30 email + benefit summary · T-14 email · T-7 email + phone-call task · T+0 email · T+14 director-call task |
| `partnership` | T-120 quarterly-review-meeting task · T-90 email + meeting-proposed task · T-60 benefit-fulfillment-report task · T-30 email + contract task · T-14 ED-phone-call task · T+0 in-person-meeting task · T+30 board-escalation task |

---

### 2.5 `at_risk_outreach`

One row per logged outreach (email / phone / meeting). Audit + history view.

```sql
CREATE TABLE at_risk_outreach (
  tenant_id        TEXT NOT NULL,
  outreach_id      UUID NOT NULL DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL,
  channel          TEXT NOT NULL,               -- 'email' | 'phone' | 'meeting'
  template_id      TEXT,                        -- for email channel
  outcome_note     TEXT,                        -- admin's free-text outcome (max 500 chars; truncated if longer)
  actor_user_id    UUID NOT NULL,
  related_audit_event_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, outreach_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, member_id) ON DELETE CASCADE,
  CHECK (channel IN ('email','phone','meeting')),
  CHECK (LENGTH(outcome_note) <= 500)
);

ALTER TABLE at_risk_outreach ENABLE ROW LEVEL SECURITY;
ALTER TABLE at_risk_outreach FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON at_risk_outreach
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

CREATE INDEX at_risk_outreach_member_timeline_idx
  ON at_risk_outreach (tenant_id, member_id, created_at DESC);
```

---

### 2.6 `tier_upgrade_suggestions`

One row per suggestion. Pending-state lifecycle per Q5 round 2.

```sql
CREATE TABLE tier_upgrade_suggestions (
  tenant_id        TEXT NOT NULL,
  suggestion_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL,
  from_plan_id     UUID NOT NULL,
  to_plan_id       UUID NOT NULL,
  reason_code      TEXT NOT NULL,               -- 'declared_turnover_above_threshold' | 'paid_invoice_volume_above_threshold' | 'multi_signal'
  evidence_jsonb   JSONB NOT NULL,              -- {turnover_thb, invoice_volume_thb, threshold_met_at, ...}
  status           TEXT NOT NULL DEFAULT 'open',
  suppressed_until TIMESTAMPTZ,
  dismissed_reason TEXT,
  -- Pending-application fields (Q5 round 2)
  accepted_at      TIMESTAMPTZ,
  accepted_by_user_id UUID,
  target_apply_at_cycle_id UUID,
  applied_at       TIMESTAMPTZ,
  applied_at_invoice_id UUID,
  member_notified_at TIMESTAMPTZ,
  admin_verification_task_id UUID,              -- T-180 verify task (if scheduled)
  -- Lifecycle
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, suggestion_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, member_id) ON DELETE CASCADE,
  CHECK (status IN ('open','accepted_pending_apply','applied','dismissed','superseded','auto_resolved')),
  CHECK (LENGTH(dismissed_reason) <= 500)
);

ALTER TABLE tier_upgrade_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tier_upgrade_suggestions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tier_upgrade_suggestions
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

-- At most one open OR pending suggestion per member
CREATE UNIQUE INDEX tier_upgrade_suggestions_member_open_idx
  ON tier_upgrade_suggestions (tenant_id, member_id)
  WHERE status IN ('open','accepted_pending_apply');

-- Cron skip-eligibility (suppressed for 90 days)
CREATE INDEX tier_upgrade_suggestions_suppressed_idx
  ON tier_upgrade_suggestions (tenant_id, status, suppressed_until)
  WHERE status = 'dismissed';

-- F4 renewal-invoice hook reads pending applications by member
CREATE INDEX tier_upgrade_suggestions_pending_apply_idx
  ON tier_upgrade_suggestions (tenant_id, target_apply_at_cycle_id)
  WHERE status = 'accepted_pending_apply';
```

### State machine

```
                       ┌──────┐
              create ──│ open │
                       └──┬───┘
       admin Accept ─────┤├────── admin Dismiss
                          │ │
                          │ └────────────────────►   ┌───────────┐
                          │                          │ dismissed │ (suppressed_until = today + 90d)
                          ▼                          └───────────┘
              ┌─────────────────────────┐
              │ accepted_pending_apply  │
              └────┬─────────────┬──────┘
                   │             │
   F4 renewal      │             │ admin manual plan change via F2
   creates invoice │             │
                   ▼             ▼
              ┌─────────┐   ┌────────────┐
              │ applied │   │ superseded │
              └─────────┘   └────────────┘

   (cron) member already at target → auto_resolved (terminal)
```

---

### 2.7 `renewal_escalation_tasks`

One row per manual task (phone call, in-person meeting, board escalation, T-180 verify-pending-tier-upgrade, etc.).

```sql
CREATE TABLE renewal_escalation_tasks (
  tenant_id        TEXT NOT NULL,
  task_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL,
  cycle_id         UUID,                        -- NULL for non-cycle tasks (e.g., verify_pending_tier_upgrade)
  task_type        TEXT NOT NULL,
  -- Examples: 'quarterly_review_meeting', 'benefit_fulfillment_report', 'phone_call',
  --           'in_person_meeting', 'board_escalation', 'verify_pending_tier_upgrade',
  --           'manual_outreach_required',
  --           'manual_admin_reactivation_review'  -- added at /speckit.clarify round 3 Q1 + M2 sync;
  --                                                  triggered by FR-005b when member.blocked_from_auto_reactivation = TRUE
  --                                                  and lapsed member completes payment
  assigned_to_role TEXT NOT NULL,
  assigned_to_user_id UUID,
  due_at           TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  outcome_note     TEXT,
  skipped_reason   TEXT,
  closed_by_user_id UUID,
  related_suggestion_id UUID,                   -- for verify_pending_tier_upgrade tasks
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, member_id) ON DELETE CASCADE,
  CHECK (status IN ('open','done','skipped')),
  CHECK (assigned_to_role IN ('admin','manager','executive_director')),
  CHECK (LENGTH(outcome_note) <= 1000),
  CHECK (LENGTH(skipped_reason) <= 500)
);

ALTER TABLE renewal_escalation_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_escalation_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON renewal_escalation_tasks
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

CREATE INDEX renewal_escalation_tasks_queue_idx
  ON renewal_escalation_tasks (tenant_id, status, due_at);

CREATE INDEX renewal_escalation_tasks_per_user_idx
  ON renewal_escalation_tasks (tenant_id, assigned_to_user_id, status)
  WHERE status = 'open';

-- Idempotency: at most one open task per (member, cycle, task_type)
CREATE UNIQUE INDEX renewal_escalation_tasks_open_idem_idx
  ON renewal_escalation_tasks (tenant_id, member_id, cycle_id, task_type)
  WHERE status = 'open';
```

---

### 2.8 `consumed_link_tokens`

Single-use tracking for renewal-link tokens. Tenant-scoped.

```sql
CREATE TABLE consumed_link_tokens (
  tenant_id        TEXT NOT NULL,
  token_sha256     BYTEA NOT NULL,
  consumed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_by_member_id UUID NOT NULL,
  cycle_id         UUID NOT NULL,
  PRIMARY KEY (tenant_id, token_sha256)
);

ALTER TABLE consumed_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumed_link_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consumed_link_tokens
  FOR ALL TO swecham_app_rw
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

-- TTL cleanup (consumed tokens >60d old can be pruned weekly)
CREATE INDEX consumed_link_tokens_age_idx
  ON consumed_link_tokens (consumed_at);
```

---

### 2.9 `scheduled_plan_changes` (F2 cross-module table — F8-PR-delivered)

> **Doc-sync remediation** (added during /speckit.implement Wave B; closes data-model.md gap discovered at T011 start). Schema is authoritative for Wave C migration 0086. F2 owns the **logical schema** (the use-cases that read/write it live in `src/modules/plans/application/`); F8 owns the **migration delivery** (per F7 precedent of F8-owns-all-9-migrations + research.md R13).

One pending row per (tenant, member, target renewal cycle). Captures an admin's intent to switch a member's plan AT the next renewal boundary, NOT immediately. F4's renewal-invoice-creation hook resolves the effective plan via this table; F8's accepted-tier-upgrade flow inserts here; F4 invoice-paid path transitions `pending → applied` atomically with `members.plan_id` update.

```sql
CREATE TABLE scheduled_plan_changes (
  tenant_id              TEXT NOT NULL,
  scheduled_change_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  member_id              UUID NOT NULL,
  -- Renewal cycle this change becomes effective at. Resolved at F4
  -- renewal-invoice-creation time when the new cycle is created.
  effective_at_cycle_id  UUID NOT NULL,
  from_plan_id           TEXT NOT NULL,    -- plan_id at scheduling time (snapshotted)
  to_plan_id             TEXT NOT NULL,    -- target plan_id
  scheduled_by_user_id   UUID NOT NULL,    -- admin who initiated (FK to users.id)
  reason                 TEXT,             -- free-form audit note (≤500 chars at app layer)
  status                 TEXT NOT NULL DEFAULT 'pending',
  -- Lifecycle timestamps
  scheduled_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at             TIMESTAMPTZ,      -- set when status flips to 'applied'
  superseded_at          TIMESTAMPTZ,      -- set when status flips to 'superseded' (admin manual change beats this row)
  cancelled_at           TIMESTAMPTZ,      -- set when status flips to 'cancelled' (admin explicit cancel)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, scheduled_change_id),
  CONSTRAINT scheduled_plan_changes_status_check
    CHECK (status IN ('pending', 'applied', 'superseded', 'cancelled'))
);

-- One pending row per (tenant, member, effective cycle) — research.md R13 +
-- tasks.md T017. Admin re-scheduling supersedes the prior pending row by
-- flipping its status to 'superseded' (NOT by deleting), so audit trail
-- retains every intent ever scheduled. The partial unique guarantees the
-- "at most one pending" invariant.
CREATE UNIQUE INDEX scheduled_plan_changes_pending_uniq
  ON scheduled_plan_changes (tenant_id, member_id, effective_at_cycle_id)
  WHERE status = 'pending';

-- Hot-path lookup by (tenant, member, cycle) — F4's getEffectivePlanForRenewal
-- resolver hits this on every renewal-invoice creation.
CREATE INDEX scheduled_plan_changes_member_cycle_idx
  ON scheduled_plan_changes (tenant_id, member_id, effective_at_cycle_id);

ALTER TABLE scheduled_plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_plan_changes FORCE ROW LEVEL SECURITY;

-- Role name `chamber_app` per F2 migration 0006 + F4 + F7 precedent
-- (verified at /speckit.verify.run Wave B finding E1). The earlier
-- F8 data-model § 2.1–2.8 tables nominally use `swecham_app_rw` —
-- a stale draft role name from before /speckit.plan locked the role
-- to `chamber_app`. Wave C migration authors MUST audit + reconcile
-- §§ 2.1–2.8 to `chamber_app` before scaffolding 0086–0094 SQL files
-- so the live DB grants line up with what's actually granted in 0006.
CREATE POLICY tenant_isolation ON scheduled_plan_changes
  FOR ALL TO chamber_app
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
```

**Status state machine** (Domain invariant):

```
pending ──schedule (insert) ──┐
                              ▼
pending ──apply (F4 paid)──→ applied   (terminal)
pending ──supersede (admin manual change-plan) ──→ superseded (terminal)
pending ──cancel (admin explicit)─→ cancelled (terminal)
```

No transitions out of terminal states. A new `pending` row may be created after a terminal row exists for the same (member, cycle) — the partial unique permits it.

---

## 3. Column extensions on existing tables

### 3.1 F3 `members` — 9 new columns (migration 0094 — extended at /speckit.tasks audit M1; +1 column added at /speckit.clarify round 3 Q1 + M2 sync)

```sql
ALTER TABLE members
  ADD COLUMN renewal_reminders_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN renewal_reminders_opted_out_at TIMESTAMPTZ,
  ADD COLUMN email_unverified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN email_unverified_at TIMESTAMPTZ,
  ADD COLUMN risk_score SMALLINT,
  ADD COLUMN risk_score_band TEXT,
  ADD COLUMN risk_score_factors JSONB,
  ADD COLUMN risk_score_last_computed_at TIMESTAMPTZ,
  ADD COLUMN risk_snoozed_until TIMESTAMPTZ,
  -- Added at /speckit.clarify round 3 Q1 (auto-reactivate admin override per FR-005b)
  ADD COLUMN blocked_from_auto_reactivation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN blocked_from_auto_reactivation_at TIMESTAMPTZ,
  ADD COLUMN blocked_from_auto_reactivation_set_by_user_id UUID,
  ADD COLUMN blocked_from_auto_reactivation_reason TEXT;

ALTER TABLE members
  ADD CONSTRAINT risk_score_range CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100)),
  ADD CONSTRAINT risk_score_band_valid CHECK (
    risk_score_band IS NULL OR
    risk_score_band IN ('healthy','warning','at-risk','critical')
  );

-- At-risk widget query needs partial index
CREATE INDEX members_at_risk_idx
  ON members (tenant_id, risk_score DESC)
  WHERE risk_score >= 50 AND risk_snoozed_until IS NULL;
```

### 3.2 F2 `membership_plans` — 1 new column (migration 0094)

See Complexity Tracking entry #2 in `plan.md` for the cross-module migration coordination rationale.

```sql
ALTER TABLE membership_plans
  ADD COLUMN renewal_tier_bucket TEXT;

UPDATE membership_plans SET renewal_tier_bucket = CASE
  WHEN plan_name = 'Thai Alumni' THEN 'thai_alumni'
  WHEN plan_name = 'Individual' THEN 'thai_alumni'
  WHEN plan_name = 'Start-up Corporate' THEN 'start_up'
  WHEN plan_name = 'Regular Corporate' THEN 'regular'
  WHEN plan_name = 'Large Corporate' THEN 'regular'
  WHEN plan_name = 'Premium Corporate' THEN 'premium'
  WHEN plan_name LIKE '%Partnership%' THEN 'partnership'
  ELSE 'regular'
END;

-- Verify zero NULL after backfill
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM membership_plans WHERE renewal_tier_bucket IS NULL) THEN
    RAISE EXCEPTION 'Backfill failed: % rows still NULL',
      (SELECT COUNT(*) FROM membership_plans WHERE renewal_tier_bucket IS NULL);
  END IF;
END $$;

ALTER TABLE membership_plans
  ALTER COLUMN renewal_tier_bucket SET NOT NULL,
  ADD CONSTRAINT plan_bucket_valid CHECK (
    renewal_tier_bucket IN ('thai_alumni','start_up','regular','premium','partnership')
  );
```

---

## 4. Audit event taxonomy (42 events — full list)

All events emitted to F1's existing `audit_log` table with `retention_years = 5`. F8 has no tax-document overlap so the F4 10-year retention backfill is irrelevant.

### Renewal lifecycle (20 events)

| Event type | Trigger | Payload |
|---|---|---|
| `renewal_cycle_created` | New cycle materialised on member creation OR previous cycle paid | `{member_id, cycle_id, period_from, period_to, plan_id, tier_bucket}` |
| `renewal_cycle_cancelled` | Admin manual cancel | `{member_id, cycle_id, reason, actor_user_id}` |
| `renewal_cycle_completed_offline` | Admin "Mark renewal as paid offline" | `{member_id, cycle_id, payment_method, payment_reference, actor_user_id}` |
| `renewal_lapsed` | grace_period_days exceeded without payment | `{member_id, cycle_id, expires_at, lapsed_at}` |
| `renewal_reminder_sent` | Cron OR admin manual dispatch | `{member_id, cycle_id, step_id, channel, template_id, delivery_id, year_in_cycle, actor_user_id}` |
| `renewal_reminder_skipped` | Cron skip path | `{member_id, cycle_id, step_id, reason}` (reason ∈ enum) |
| `renewal_reminder_send_failed` | Resend API error | `{member_id, cycle_id, step_id, failure_reason, retry_count}` |
| `renewal_schedule_rescheduled` | Member's tier bucket changed mid-cycle | `{member_id, cycle_id, old_tier_bucket, new_tier_bucket}` |
| `renewal_schedule_policy_updated` | Admin edit schedule policy | `{tier_bucket, change_diff, actor_user_id}` |
| `renewal_self_service_initiated` | Member clicks "Renew now" link | `{member_id, cycle_id, token_iat}` |
| `renewal_invoice_created` | F4 invoice issued via renewal flow | `{member_id, cycle_id, invoice_id, plan_id, amount, vat}` |
| `renewal_with_plan_change` | Member chose plan change during renewal | `{member_id, cycle_id, from_plan_id, to_plan_id, invoice_id}` |
| `renewal_payment_failed` | F5 returned payment_failed | `{member_id, cycle_id, invoice_id, failure_reason}` |
| `renewal_completed` | F5 payment_succeeded → cycle.status = completed | `{member_id, cycle_id, invoice_id, paid_at, new_expires_at}` |
| `renewal_completed_post_lapse` | Lapsed member completed renewal payment | `{member_id, cycle_id, invoice_id, was_lapsed_at}` |
| `renewal_token_invalid` | Token verification fail | `{tenant_id, sha256_token_hash, reason}` (reason ∈ malformed/mac_mismatch/expired/replay/cross_tenant) |
| `renewal_kill_switch_blocked` | FEATURE_F8_RENEWALS=false | `{route, actor?}` |
| `renewal_cross_tenant_probe` | Cross-tenant access attempt | `{actor, attempted_tenant, attempted_member?}` |
| `renewal_cross_member_probe` | Cross-member portal access | `{actor_member_id, attempted_member_id}` |
| `renewal_reminder_deferred_read_only` | READ_ONLY_MODE active during cron | `{cycle_id, step_id}` |
| `renewal_cycle_price_frozen` | New cycle materialised + frozen price snapshot taken (Q2 round 3) | `{cycle_id, plan_id, frozen_price_thb, frozen_term_months, frozen_currency}` |
| `lapsed_member_admin_reactivated` | Admin approved a `pending_admin_reactivation` cycle (Q1 round 3) | `{member_id, cycle_id, actor_user_id}` |
| `lapsed_member_admin_reactivation_rejected` | Admin rejected a `pending_admin_reactivation` cycle + refund initiated (Q1 round 3) | `{member_id, cycle_id, actor_user_id, refund_id, credit_note_id}` |
| `lapsed_member_admin_reactivation_timed_out` | FR-005c auto-timeout fired after 30d in pending state (M3) | `{member_id, cycle_id, entered_pending_at, refund_id, credit_note_id}` |
| `member_auto_reactivation_blocked` | Admin set `blocked_from_auto_reactivation = TRUE` (Q1 round 3) | `{member_id, actor_user_id, reason}` |
| `member_auto_reactivation_unblocked` | Admin cleared `blocked_from_auto_reactivation` (Q1 round 3) | `{member_id, actor_user_id, reason}` |

### Lapsed + bounce (3 events)

| Event type | Trigger | Payload |
|---|---|---|
| `lapsed_member_action_blocked` | Lapsed member hit blocked route | `{member_id, attempted_route, attempted_action}` |
| `member_email_unverified_threshold_crossed` | FR-012a threshold crossed | `{member_id, trigger, bounce_count, classification}` |
| `f8_role_violation_blocked` | Manager attempted F8 mutation OR member attempted admin endpoint | `{actor_user_id, actor_role, attempted_route, attempted_action}` |

### At-risk (6 events)

| Event type | Trigger | Payload |
|---|---|---|
| `at_risk_score_recomputed` | Weekly cron per member | `{member_id, score, factors, threshold_band}` |
| `at_risk_score_threshold_crossed` | Band changed to higher-risk on this run | `{member_id, from_band, to_band}` |
| `at_risk_snoozed` | Admin snooze | `{member_id, snooze_duration_days, actor_user_id}` |
| `at_risk_outreach_recorded` | Admin recorded outreach | `{member_id, outreach_id, channel, template_id}` |
| `at_risk_skipped_below_min_tenure` | Member newer than threshold | `{member_id, tenure_days}` |
| `at_risk_compute_partial_failure` | Cron failed for one tenant | `{tenant_id, error_class, members_processed, members_failed}` |

### Tier-upgrade (10 events)

| Event type | Trigger | Payload |
|---|---|---|
| `tier_upgrade_suggested` | Cron created new suggestion | `{member_id, suggestion_id, from_plan_id, to_plan_id, reason_code, evidence}` |
| `tier_upgrade_accepted` | Admin clicked Accept | `{suggestion_id, accepted_by_user_id, target_apply_at_cycle_id}` |
| `tier_upgrade_pending_member_notified` | Member email dispatched | `{suggestion_id, member_id, target_plan_id, effective_at, delivery_id}` |
| `tier_upgrade_pending_admin_verification_due` | T-180 verify task created | `{suggestion_id, task_id, due_at}` |
| `tier_upgrade_applied_at_renewal` | F4 renewal invoice issued at upgraded plan | `{suggestion_id, member_id, from_plan_id, to_plan_id, applied_at_cycle_id, invoice_id}` |
| `tier_upgrade_pending_superseded_by_manual_change` | F2 manual plan change during pending | `{suggestion_id, manual_change_actor}` |
| `tier_upgrade_dismissed` | Admin clicked Dismiss | `{suggestion_id, dismissed_reason, suppressed_until, actor_user_id}` |
| `tier_upgrade_already_at_target` | Cron found member at suggested tier | `{member_id, current_plan_id, evaluated_target_plan_id}` |
| `tier_upgrade_tenant_disabled` | Cron skipped tenant by setting | `{tenant_id}` |
| `tier_upgrade_skipped_no_thresholds_configured` | Tenant lacks F2 threshold metadata | `{tenant_id}` |

### Escalation tasks (4 events)

| Event type | Trigger | Payload |
|---|---|---|
| `escalation_task_created` | Cron OR admin created task | `{task_id, member_id, cycle_id, task_type, due_at, assigned_to_role}` |
| `escalation_task_completed` | Admin marked done | `{task_id, outcome_note?, actor_user_id}` |
| `escalation_task_skipped` | Admin marked skipped | `{task_id, skipped_reason, actor_user_id}` |
| `escalation_task_reassigned` | Admin reassigned | `{task_id, from_user_id, to_user_id, actor_user_id}` |

**Total at /speckit.critique 2026-05-03 round 1**: 47 events.
**+5 events at /speckit.clarify round 3 Q1 + Q2** (`renewal_cycle_price_frozen`, `lapsed_member_admin_reactivated`, `lapsed_member_admin_reactivation_rejected`, `member_auto_reactivation_blocked`, `member_auto_reactivation_unblocked`).
**+1 event at /speckit.critique round 2 / M3** (`lapsed_member_admin_reactivation_timed_out`).
**Total: 53 events** (cumulative through round-2 critique).

---

## 5. RLS + FORCE summary

All 8 new tables (`renewal_cycles`, `renewal_reminder_events`, `tenant_renewal_settings`, `tenant_renewal_schedule_policies`, `at_risk_outreach`, `tier_upgrade_suggestions`, `renewal_escalation_tasks`, `consumed_link_tokens`) have:

- `ENABLE ROW LEVEL SECURITY`
- `FORCE ROW LEVEL SECURITY` (so even table owner respects policies)
- `CREATE POLICY tenant_isolation FOR ALL TO swecham_app_rw USING (tenant_id = current_setting('app.current_tenant', TRUE))`

Cross-tenant integration test (`tests/integration/renewals/tenant-isolation.test.ts`) is the Review-Gate blocker per Constitution v1.4.0 Principle I clause 3.

---

## 6. Migration atomicity + rollback

Migrations 0086–0094 each follow the F4/F5/F7 pattern:
- DDL (CREATE TABLE / ALTER TABLE) inside a transaction
- Default fixture seeds (e.g., 5 schedule policies per tenant) inside the same tx
- `CREATE INDEX CONCURRENTLY` outside the migration tx (separate immediate follow-up file)
- Rollback path: each migration ships a `0086_DOWN.sql` companion (etc. through 0094) that drops the new artefacts in reverse order; not used in normal operation but documented for emergency rollback

Migration 0094 (cross-module column extensions) is special:
- F3 `members` extensions are additive only (defaults provided)
- F2 `membership_plans` extension uses the 5-step backfill described in research.md R9 to guarantee zero NULL post-migration

---

## 7. Cross-references to spec

| Data model artefact | Spec FR / Clarification |
|---|---|
| `renewal_cycles` table | FR-001, FR-002, FR-003, FR-004, FR-007a |
| `renewal_cycles.frozen_plan_*` (Q2 round 3) | FR-021a NEW, FR-021b NEW, FR-022 |
| `renewal_cycles.status` includes `pending_admin_reactivation` (Q1 round 3) | FR-005b NEW, FR-005c NEW (M3 timeout) |
| `renewal_reminder_events` table | FR-010, FR-011, FR-012, FR-018 |
| `tenant_renewal_settings` | FR-003, FR-035, FR-041 |
| `tenant_renewal_schedule_policies` | FR-008, FR-009, Q2 round 1 |
| `at_risk_outreach` table | FR-033 |
| `tier_upgrade_suggestions` table | FR-038, FR-039, Q5 round 2 |
| `renewal_escalation_tasks` table + `manual_admin_reactivation_review` task_type | FR-043, FR-044, FR-045, FR-005b (Q1 round 3) |
| `consumed_link_tokens` table | FR-026, FR-027, R1 |
| `members.email_unverified` | FR-012a, Q4 round 2 |
| `members.renewal_reminders_opted_out` | FR-016 |
| `members.risk_*` columns | FR-028, FR-029, FR-029a, FR-030, FR-032 |
| `members.blocked_from_auto_reactivation` (Q1 round 3) | FR-005b NEW |
| `membership_plans.renewal_tier_bucket` | FR-008, Q2 round 1, Complexity Tracking #2 |
| Audit event taxonomy (53 events cumulative) | FR-048, FR-053 (cascade), all section events + Q1/Q2 round 3 + M3 |
| RLS+FORCE | Constitution Principle I, FR-047, SC-006 |
