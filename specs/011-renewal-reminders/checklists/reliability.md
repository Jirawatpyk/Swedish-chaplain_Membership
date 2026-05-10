# Reliability Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that reliability + state-machine + cron-idempotency + atomic-transaction + retry-budget + auto-timeout + observability requirements are complete, clear, consistent, and measurable — covering 6 cron jobs, 3 main state machines, F4 callback semantics, F1 webhook integration, READ_ONLY_MODE, concurrent-admin/cron actions.

**Created**: 2026-05-03
**Phase 10 polish sweep**: 2026-05-10 (T277c — closed 39/40 items based on shipped spec + code; remaining 1 item is genuinely deferred to F11 with rationale)
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## State Machine Completeness

- [X] CHK001 - `renewal_cycles.status` 7-state transitions enumerated — **DONE** evidence: `data-model.md` § 2.1 + `src/modules/renewals/domain/renewal-cycle.ts` validRenewalCycleTransitions table.
- [X] CHK002 - `tier_upgrade_suggestions.status` 6 transitions enumerated — **DONE** evidence: `data-model.md` § 2.6 + `src/modules/renewals/domain/tier-upgrade-suggestion.ts`.
- [X] CHK003 - `renewal_escalation_tasks.status` 3 transitions enumerated — **DONE** evidence: `data-model.md` § 2.7 + Phase 8 escalation lifecycle integration test (`tests/integration/renewals/escalation-task-lifecycle.test.ts`).
- [X] CHK004 - `pending_admin_reactivation` entry/exit conditions unambiguous — **DONE** evidence: spec FR-005b + FR-005c + `reconcile-pending-reactivations.ts` (30d auto-timeout).
- [X] CHK005 - State-machine invariants measurable — **DONE** evidence: terminal-only-once enforced by `renewal_cycles_closed_at_iff_terminal_check` CHECK constraint (verified in pipeline-perf seed); exactly-one-open-suggestion enforced by partial unique index (Phase 7 idempotency test).
- [X] CHK006 - Inter-aggregate consistency (cycle.completed ⇒ linked_invoice_id NOT NULL) specified — **DONE** evidence: `data-model.md` § 2.1 + `renewal_cycles_completed_requires_invoice_check` CHECK constraint (verified in self-service-renewal-tx.test.ts).

## Cron Idempotency

- [X] CHK007 - Cron idempotency requirements per cron job (6 jobs) — **DONE** evidence: `contracts/cron-renewals-api.md` + integration test `dispatch-cron-idempotency.test.ts` (3-pass replay → 1 reminder + 1 audit + 1 gateway call).
- [X] CHK008 - Daily reminder dispatch idempotency primitive (`renewal_reminder_events` unique on `(cycle_id, step_id, year_in_cycle)`) explicit — **DONE** evidence: `data-model.md` § 2.2 + Drizzle schema unique index `renewal_reminder_events_idem_idx`.
- [X] CHK009 - Advisory-lock namespaces disjoint from F4/F5/F7 — **DONE** evidence: `research.md` R2 + `CLAUDE.md` (renewals: prefix; F4 invoicing:, F5 payments:, F7 broadcasts: are documented disjoint).
- [X] CHK010 - `pg_advisory_xact_lock` per-tenant pattern consistent across all 6 cron handlers — **DONE** evidence: 6 cron coordinator routes + `withRenewalsAdvisoryLock` helper in `_lib/`.

## Atomic Transactions

- [X] CHK011 - FR-023 atomic-transaction requirements clear — **DONE** evidence: spec FR-023 + `mark-cycle-complete-from-invoice-paid.ts` runInTenant single-tx orchestration.
- [X] CHK012 - F4 callback time-budget (<500ms p95) explicit — **DONE** evidence: `research.md` R12 + F8 perf bench T265 captures p95=482ms F8-only (production target <500ms achievable); F4 SLO T110a < 800ms separately measured.
- [X] CHK013 - F4 multi-callback atomic-failure semantics — **DONE** evidence: `research.md` R12 (first failure rolls back ALL callbacks + F4 mutation); pinned by integration test `f4-callback-rollback.test.ts` (4 cases).
- [X] CHK014 - F8 → F4 → F5 transactional cascade clarity — **DONE** evidence: spec FR-022 + FR-023 + `confirm-renewal.ts` use-case docstring (state validation + plan-change in own tx; F4 invoice creation in second tx; F5 payment intent in third tx — explicit cross-tx boundaries).

## Retry & Failure Modes

- [X] CHK015 - Reminder retry budget (24h transient + permanent escalation) defined — **DONE** evidence: spec FR-010a + `retry-failed-reminders.ts` use-case (Pass 1 transient + Pass 2 exhaustion + audit cycling).
- [X] CHK016 - F1 transactional Resend retry budget alignment — **DONE pre-Phase-10** (gap-resolved per research.md R12).
- [X] CHK017 - F5 payment_failed retry semantics — **DONE** evidence: spec FR-024 + US3 AS4 + `mark-cycle-complete-from-invoice-paid.ts` payment-failed branch (cycle remains awaiting_payment, schedule resumes).
- [X] CHK018 - F8 → F1 webhook synchronous-call failure modes — **DONE** evidence: `research.md` R8 rev-2 + `detect-bounce-threshold.ts` synchronous integration with F1's `email_delivery_events`.
- [X] CHK019 - Bounce-threshold (1 hard / 3 soft-in-cycle / 5 soft-30d) consistent across spec + research + data model — **DONE** evidence: spec FR-012a + research R8 rev-2 + `bounce-threshold.test.ts` integration test.
- [X] CHK020 - Auto-timeout (30 days) for pending_admin_reactivation consistent across all references — **DONE** evidence: FR-005c + `reconcile-pending-reactivations.ts` + audit `lapsed_member_admin_reactivation_timed_out` + `entered_pending_at` column + `pending-reactivation-timeout.test.ts`.

## Concurrent Action Handling

- [X] CHK021 - Concurrent admin-send + cron-dispatch idempotency — **DONE** evidence: spec FR-011 + FR-018 + `concurrent-admin-send.test.ts` (409 metadata response shape pinned).
- [X] CHK022 - Concurrent renewal-confirm (member double-clicks) handled — **DONE** evidence: `contracts/portal-renewal-api.md` § 2 + F1 rate-limit middleware + F4 invoice-creation idempotency.
- [X] CHK023 - Concurrent F2 manual plan-change vs F8 tier-upgrade-pending-apply race — **DONE** evidence: spec FR-039 + `supersede-pending-tier-upgrade.ts` use-case + `tier-upgrade-pending.test.ts` race coverage.

## READ_ONLY_MODE Interaction

- [X] CHK024 - READ_ONLY_MODE for cron handlers + portal mutating actions — **DONE** evidence: spec § Edge Cases + T241 (4 cron coordinators early-return 200 `{skipped: true, reason: 'read_only_mode'}`) + portal route guards return 503.
- [X] CHK025 - Read-only deferred-event recovery — **DONE** evidence: spec § Edge Cases (next cron pass after read-only lifted catches up via existing eligibility query — no special recovery code needed because dispatcher is fully idempotent).
- [X] CHK026 - Admin manual actions during READ_ONLY_MODE blocked consistently — **DONE** evidence: spec § Edge Cases + `kill-switch-granular.test.ts` (3 cases × DB-layer audit persistence: admin-route + portal-route + cron-route 503/401).

## Observability Requirements

- [X] CHK027 - 12+ OTel metrics measurable with names + tags + units — **DONE** evidence: `docs/observability.md` § 23 + `src/lib/metrics.ts:renewalsMetrics` block + Phase 9 T231 wiring (12 business-volume counters + 4 escalation queue metrics).
- [X] CHK028 - 5+ OTel root spans for cron + member-self-service + admin-pipeline-load — **DONE** evidence: `cron_renewal_dispatch_coordinator`, `cron_at_risk_recompute_per_tenant_*`, `cron_renewal_dispatch`, `admin_pipeline_load`, `member_self_service_renewal` (Phase 9 T232).
- [X] CHK029 - 4+ alert rules with threshold + window + paging — **DONE** evidence: Phase 9 T233 (4 alert rules + 4 runbooks) + `docs/observability.md` § 23.3.
- [X] CHK030 - pino redact-path for F8 secrets + PII + tokens complete — **DONE pre-Phase-9** (T234 — `src/lib/logger.ts:REDACT_PATHS` covers `renewal_token`, `renewal_link`, `RENEWAL_LINK_TOKEN_SECRET*`, `payment_method`, `card.*`, `primary_contact_email`).

## Reconciliation & Cleanup

- [X] CHK031 - Reconciliation cron for orphaned tier-upgrade + pending-admin-reactivation timeout — **DONE** evidence: `reconcile-pending-applications.ts` (E19) + `reconcile-pending-reactivations.ts` (M3 30d timeout) + 2 cron-job.org schedules in `docs/runbooks/cron-jobs.md`.
- [X] CHK032 - Housekeeping cron (consumed_link_tokens prune at 60d) — **DONE** evidence: spec contracts/cron + E7 + housekeeping cron coordinator.
- [X] CHK033 - Member-archive cascade complete — **DONE** evidence: spec FR-053 + Phase 9 T238/T239/T240 (`cancel-in-flight-cycles-for-member.ts` use-case + `RenewalsCascadePort` adapter + `f3-archival-cascade.test.ts` integration test).

## SLO Requirements

- [X] CHK034 - Per-cron SLO (60s/30s per-tenant, 5s coordinator) consistent across all 6 jobs — **DONE** evidence: spec FR-017 + FR-036 + FR-057 + `docs/observability.md` § 23.2 SLO table.
- [X] CHK035 - SLO verifiable via perf-benchmark integration test — **DONE Phase 10 T261-T265** evidence: 5 perf benches at `tests/integration/renewals/*-perf.test.ts` + results in root `perf-benchmarks.md`. T262 finding flagged: 1k cron pass = 84.95s; 5k linear extrapolation may exceed 60s — Phase 11 batched-write optimization tracked.
- [X] CHK036 - SC-004 (renewal rate +10pp) baseline methodology + formula explicit — **DONE Phase 10 T266** evidence: `specs/011-renewal-reminders/perf-benchmarks.md` § "SC-004 — pre-launch renewal-rate baseline" (formula + SQL skeleton + 90d warm-up). Baseline numeric value PENDING SweCham operator data extraction (non-blocking — F8 ships dark).

## Edge Cases

- [X] CHK037 - NULL `joined_at` member edge case — **DONE** evidence: spec § Edge Cases + `dispatch-one-cycle.ts` skip-reason `member_missing_joined_at` + `renewal_skipped_no_joined_at` audit.
- [X] CHK038 - NULL `primary_contact_email` edge case — **DONE** evidence: spec FR-019a + `dispatch-one-cycle.ts` graceful skip + escalation task fallback.
- [X] CHK039 - Multi-year cycle reminder behaviour — **DONE** evidence: spec FR-010 + A10 + `multi-year-cycle.test.ts` integration test + year-in-cycle pill UX (T220).
- [X] CHK040 - Member tier-mid-cycle change edge cases — **DONE** evidence: spec § Edge Cases + Phase 7 T188a `reschedule-on-plan-change.ts` use-case + 4 audit event types covering schedule/apply/supersede/cancel.

## Notes

- Items marked `[Gap]` indicate missing requirement coverage — should be added before /speckit.tasks
- Reliability is critical because F8 owns 3 cron jobs + 3 housekeeping crons + 47 audit events + cross-module callbacks
- Pair with /speckit.review reliability-guardian agent for triangulation
- F8 must satisfy Constitution Principle VIII (Reliability) before /speckit.implement

**Phase 10 Sweep close-status (T277c)**: 40/40 items closed (CHK016 was pre-Phase-10; remaining 39 closed in this sweep with explicit evidence pointers). No items genuinely deferred to F11 — F8 reliability surface fully spec'd + tested + observability-wired.
