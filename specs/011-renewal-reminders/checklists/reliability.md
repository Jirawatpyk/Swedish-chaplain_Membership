# Reliability Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that reliability + state-machine + cron-idempotency + atomic-transaction + retry-budget + auto-timeout + observability requirements are complete, clear, consistent, and measurable — covering 6 cron jobs, 3 main state machines, F4 callback semantics, F1 webhook integration, READ_ONLY_MODE, concurrent-admin/cron actions.

**Created**: 2026-05-03
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## State Machine Completeness

- [ ] CHK001 - Are `renewal_cycles.status` state-machine transitions (7 states) exhaustively enumerated with valid transitions? [Coverage, Spec §FR-002, §data-model.md § 2.1]
- [ ] CHK002 - Are `tier_upgrade_suggestions.status` transitions (6 statuses) exhaustively enumerated? [Coverage, Spec §data-model.md § 2.6]
- [ ] CHK003 - Are `renewal_escalation_tasks.status` transitions (3 statuses) exhaustively enumerated? [Coverage, Spec §data-model.md § 2.7]
- [ ] CHK004 - Are `pending_admin_reactivation` entry conditions (lapsed + payment + blocked_from_auto_reactivation) AND exit conditions (admin approve / reject / 30d timeout) unambiguous? [Clarity, Spec §FR-005b, §FR-005c]
- [ ] CHK005 - Are state-machine invariants (e.g., terminal-only-once, exactly one open suggestion per member) measurable? [Measurability, Spec §FR-002, §FR-038]
- [ ] CHK006 - Are inter-aggregate consistency requirements (renewal_cycle.status `completed` ⇒ linked_invoice_id NOT NULL) specified? [Consistency, Spec §data-model.md § 2.1]

## Cron Idempotency

- [ ] CHK007 - Are cron idempotency requirements (re-run produces zero duplicates) specified per cron job (6 jobs)? [Coverage, Spec §FR-011, §contracts/cron-renewals-api.md]
- [ ] CHK008 - Is the daily reminder dispatch idempotency primitive (`renewal_reminder_events` unique on `(cycle_id, step_id, year_in_cycle)`) explicit? [Clarity, Spec §FR-011, §data-model.md § 2.2]
- [ ] CHK009 - Are advisory-lock namespaces (`renewals:dispatch:` vs `renewals:atrisk:` vs `renewals:tierupgrade:`) disjoint from F4/F5/F7 namespaces and documented? [Consistency, Spec §research.md R2]
- [ ] CHK010 - Is the `pg_advisory_xact_lock` per-tenant pattern consistent across all 6 cron handlers? [Consistency, Spec §FR-017, §contracts/cron]

## Atomic Transactions

- [ ] CHK011 - Are FR-023 atomic-transaction requirements (cycle complete + invoice mark-paid + reminder cancel + receipt email queue in 1 tx) clearly defined? [Clarity, Spec §FR-023]
- [ ] CHK012 - Are F4 callback time-budget requirements (<500ms p95) explicit to prevent F4 transaction lock contention? [Clarity, Spec §research.md R12]
- [ ] CHK013 - Are F4 multi-callback atomic-failure semantics (first failure rolls back ALL callbacks + F4 mutation) specified? [Consistency, Spec §research.md R12]
- [ ] CHK014 - Is the F8 → F4 → F5 transactional cascade requirement (US3 atomic confirm → invoice → payment intent) clear about which steps are in the same tx vs across-tx? [Clarity, Spec §FR-022, §FR-023]

## Retry & Failure Modes

- [ ] CHK015 - Are reminder retry budget requirements (24h window for transient failures + permanent-failure escalation) defined? [Completeness, Spec §FR-010a]
- [X] CHK016 - Are F1 transactional Resend retry budget requirements (per F1 contract, F8 reuse) consistent? [Consistency, Spec §research.md R12 §F1 transactional Resend retry budget alignment — gap-resolved]
- [ ] CHK017 - Are F5 payment_failed retry semantics (cycle remains awaiting_payment, schedule resumes) specified? [Completeness, Spec §FR-024, §US3 AS4]
- [ ] CHK018 - Are F8 → F1 webhook synchronous-call failure modes (F8 use-case throws → F1 webhook returns 500 → Resend retries) covered? [Coverage, Spec §research.md R8 rev-2]
- [ ] CHK019 - Are bounce-threshold detection requirements (1 hard / 3 soft-in-cycle / 5 soft-30d) consistent across spec + research + data model? [Consistency, Spec §FR-012a, §research.md R8 rev-2]
- [ ] CHK020 - Is the auto-timeout (30 days) for `pending_admin_reactivation` consistent across all references (FR-005c + audit + cron contract + entered_pending_at column)? [Consistency, Spec §FR-005c]

## Concurrent Action Handling

- [ ] CHK021 - Are concurrent admin-send + cron-dispatch idempotency requirements clear? [Clarity, Spec §FR-011, §FR-018]
- [ ] CHK022 - Are concurrent renewal-confirm requirements (member double-clicks Confirm) handled by rate limit + idempotent F4 invoice creation? [Coverage, Spec §contracts/portal-renewal-api.md § 2]
- [ ] CHK023 - Are concurrent F2 manual plan-change + F8 tier-upgrade-pending-apply race requirements specified (superseded transition)? [Coverage, Spec §FR-039]

## READ_ONLY_MODE Interaction

- [ ] CHK024 - Are READ_ONLY_MODE interaction requirements specified for cron handlers (skip + audit) AND portal mutating actions (503)? [Coverage, Spec §Edge Cases]
- [ ] CHK025 - Are read-only deferred-event recovery requirements documented (next cron pass after read-only lifted catches up)? [Completeness, Spec §Edge Cases]
- [ ] CHK026 - Are admin manual actions during READ_ONLY_MODE blocked consistently (send-reminder-now, snooze, accept, mark-task-done all return 503)? [Consistency, Spec §Edge Cases]

## Observability Requirements

- [ ] CHK027 - Are OTel metric requirements (12+ metrics) measurable with specific names + tags + units? [Measurability, Spec §FR-054]
- [ ] CHK028 - Are OTel span requirements (5+ root spans) defined for cron + member-self-service + admin-pipeline-load? [Completeness, Spec §FR-055]
- [ ] CHK029 - Are alert rule requirements (4+ alerts) defined with explicit threshold + window + paging? [Completeness, Spec §FR-056]
- [ ] CHK030 - Are pino structured log redact-path requirements complete for F8 secrets + PII + tokens? [Completeness, Spec §FR-049]

## Reconciliation & Cleanup

- [ ] CHK031 - Are reconciliation cron requirements specified for orphaned tier-upgrade pending applications (E19) AND pending-admin-reactivation timeout (M3)? [Completeness, Spec §contracts/cron, §FR-005c]
- [ ] CHK032 - Are housekeeping cron requirements (consumed_link_tokens prune at 60d) defined? [Completeness, Spec §contracts/cron, §E7]
- [ ] CHK033 - Are member-archive cascade requirements complete (cycle cancel + tasks cancel + suggestions cancel + outreach kept-for-audit)? [Coverage, Spec §FR-053]

## SLO Requirements

- [ ] CHK034 - Are per-cron SLO requirements (60s/30s per-tenant, 5s coordinator) consistent across all 6 jobs and FR-017/FR-036/FR-057? [Consistency, Spec §FR-017, §FR-036, §FR-057]
- [ ] CHK035 - Are SLO requirements verifiable via a perf-benchmark integration test before /speckit.review? [Acceptance Criteria, Spec §SC-005]
- [ ] CHK036 - Is SC-004 (renewal rate +10pp) baseline measurement methodology + formula explicit? [Measurability, Spec §SC-004, §research.md R11]

## Edge Cases

- [ ] CHK037 - Are NULL `joined_at` member edge case requirements (cron skip + admin tray + audit) defined? [Edge Case, Spec §Edge Cases]
- [ ] CHK038 - Are NULL `primary_contact_email` edge case requirements (FR-019a graceful skip + escalation task) specified? [Edge Case, Spec §FR-019a]
- [ ] CHK039 - Are multi-year cycle reminder behaviour edge cases (year-in-cycle index + email-skip-non-final-year) covered? [Edge Case, Spec §FR-010, §A10]
- [ ] CHK040 - Are member tier-mid-cycle change edge cases (reschedule remaining reminders, audit reschedule reason) covered? [Edge Case, Spec §Edge Cases]

## Notes

- Items marked `[Gap]` indicate missing requirement coverage — should be added before /speckit.tasks
- Reliability is critical because F8 owns 3 cron jobs + 3 housekeeping crons + 47 audit events + cross-module callbacks
- Pair with /speckit.review reliability-guardian agent for triangulation
- F8 must satisfy Constitution Principle VIII (Reliability) before /speckit.implement
